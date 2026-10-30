/**
 * @license
 * Copyright 2026 The Keras Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

/**
 * Git wrapper for the release bot.
 *
 * - Runs `git` through `execFileSync`, never a shell, with
 *   `core.hooksPath=/dev/null` so no target-repo hook can ever execute.
 * - Never logs the authenticated remote URL: every error message, stdout and
 *   stderr is redacted before it is rethrown.
 * - `pushBotRef` is the only push helper and refuses any destination outside
 *   `refs/heads/release-tool/`.
 */

const { execFileSync } = require("node:child_process");

const BOT_REF_PREFIX = "release-tool/";

function redact(text) {
  return String(text == null ? "" : text).replace(
    /x-access-token:[^@\s]*@/g,
    "x-access-token:***@",
  );
}

class GitError extends Error {
  constructor(args, err) {
    const stderr = redact(err.stderr);
    super(`git ${redact(args.join(" "))} failed: ${stderr.trim()}`);
    this.name = "GitError";
    this.status = err.status;
    this.stdout = redact(err.stdout);
    this.stderr = stderr;
  }
}

/**
 * Runs git with hooks disabled. Returns stdout as a string.
 * `input` is written to stdin (used for `hash-object --stdin`).
 */
function git(args, { cwd, env, input } = {}) {
  const fullArgs = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "protocol.file.allow=never",
    ...args,
  ];
  try {
    return execFileSync("git", fullArgs, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(env || {}) },
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    throw new GitError(args, err);
  }
}

/** Builds `https://x-access-token:<token>@github.com/<owner>/<repo>.git`. */
function withAuthRemote(url, token) {
  const parsed = new URL(url);
  parsed.username = "x-access-token";
  parsed.password = token;
  return parsed.toString();
}

/**
 * Force-pushes HEAD to `refs/heads/<ref>`; `ref` must start with
 * `release-tool/`. Release branches and tags are never pushed with git.
 */
function pushBotRef(gitFn, { cwd, remoteUrl, ref }) {
  if (typeof ref !== "string" || !ref.startsWith(BOT_REF_PREFIX) ||
      ref.includes("..") || ref.includes(":")) {
    throw new Error(`refusing to push to non-bot ref: ${ref}`);
  }
  // The prefix is written literally so static.test.js can verify the
  // destination; `suffix` is the part of `ref` after `release-tool/`.
  const suffix = ref.slice(BOT_REF_PREFIX.length);
  return gitFn(
    ["push", "--force", remoteUrl, `HEAD:refs/heads/release-tool/${suffix}`],
    { cwd });
}

/**
 * A local clone of the (public) target repo. Every command goes through the
 * injected `gitFn`, so tests replace git entirely. Commits are authored by
 * `identity` via GIT_* env vars; nothing is written to git config.
 */
class Workspace {
  constructor({ gitFn, cwd, identity, pushUrl }) {
    this.gitFn = gitFn;
    this.cwd = cwd;
    this.pushUrl = pushUrl;
    const email = `${identity}@users.noreply.github.com`;
    this.env = {
      GIT_AUTHOR_NAME: identity, GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: identity, GIT_COMMITTER_EMAIL: email,
    };
  }

  run(args, input) {
    return String(this.gitFn(args, { cwd: this.cwd, env: this.env, input }));
  }

  /** Blobless clone over anonymous https; the push URL is used only to push. */
  clone(url) {
    this.gitFn(["clone", "--quiet", "--no-tags", "--filter=blob:none",
      "--no-checkout", url, this.cwd], { env: this.env });
  }

  resetBranch(name, sha) {
    this.run(["checkout", "--quiet", "--force", "-B", name, sha]);
  }

  /**
   * Applies one pick; `args` is the full argv from picks.cherryPickArgs.
   * Returns `{ result: "applied" | "empty" }` or `{ result: "conflict",
   * files }` after `cherry-pick --abort`.
   */
  cherryPick(args) {
    if (args[0] !== "cherry-pick") throw new Error(`not a cherry-pick: ${args.join(" ")}`);
    try {
      this.run(args);
      return { result: "applied" };
    } catch (err) {
      const files = this.run(["diff", "--name-only", "--diff-filter=U"])
        .split("\n").filter(Boolean);
      const output = `${err.stdout || ""}\n${err.stderr || ""}`;
      if (files.length === 0 && /is now empty|nothing to commit/i.test(output)) {
        this.run(["cherry-pick", "--skip"]);
        return { result: "empty" };
      }
      try {
        this.run(["cherry-pick", "--abort"]);
      } catch (abortErr) {
        // No cherry-pick in progress: nothing to abort.
      }
      if (files.length === 0) throw err;
      return { result: "conflict", files };
    }
  }

  /** First-parent commits in `range` touching `files`: `[{ sha, subject }]`. */
  commitsTouching(range, files) {
    return this.run(["log", "--first-parent", "--format=%H%x09%s", range,
      "--", ...files]).split("\n").filter(Boolean).map((line) => {
      const tab = line.indexOf("\t");
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
  }

  mergeBase(a, b) {
    return this.run(["merge-base", a, b]).trim();
  }

  /**
   * Rewrites every file whose version differs from `version` in the index
   * and commits. Returns false (no commit) when all files already match.
   */
  commitVersion(files, version, { read, rewrite, message }) {
    let changed = false;
    for (const file of files) {
      const text = this.run(["show", `HEAD:${file}`]);
      if (read(text) === version) continue;
      const blob = this.run(["hash-object", "-w", "--stdin"],
        rewrite(text, version)).trim();
      const mode = this.run(["ls-tree", "HEAD", "--", file]).split(/\s+/)[0];
      this.run(["update-index", "--cacheinfo", `${mode || "100644"},${blob},${file}`]);
      changed = true;
    }
    if (changed) this.run(["commit", "--quiet", "-m", message]);
    return changed;
  }

  commitCount(base) {
    return Number(this.run(["rev-list", "--count", `${base}..HEAD`]).trim());
  }

  pushBotRef(ref) {
    return pushBotRef((args, opts) => this.gitFn(args, { ...opts, env: this.env }),
      { cwd: this.cwd, remoteUrl: this.pushUrl, ref });
  }
}

module.exports = {
  BOT_REF_PREFIX,
  GitError,
  Workspace,
  git,
  pushBotRef,
  redact,
  withAuthRemote,
};
