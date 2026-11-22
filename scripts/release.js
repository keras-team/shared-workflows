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
 * Release panel for keras-team repos (.github/workflows/release.yml).
 *
 * - `prepare`: cuts the release branch `rX.Y` if it does not exist, applies
 *   the cherry-picks in the default branch's order, sets `__version__` and
 *   opens one PR into the release branch.
 * - `draft-release`: once that PR is merged, creates a draft GitHub release
 *   with generated notes. A person edits and publishes it, which creates the
 *   tag and starts the repo's own PyPI publish workflow.
 *
 * Each action only checks its own preconditions; nothing is stored between
 * runs. The bot never merges a PR and never publishes a release.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const OWNER = "keras-team";
const ACTIONS = ["prepare", "draft-release"];
const RELEASE_TYPES = ["major", "minor", "patch"];
const STAGES = ["final", "dev"];
const REPO_RE = /^[A-Za-z0-9._-]+$/;
const VERSION_RE = /^\d+\.\d+\.\d+((a|b|rc)\d+|\.dev\d+)?$/;
const FINAL_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const VERSION_LINE_RE = /^__version__ = .*$/m;

module.exports = async function release({ github, core, env, cwd }) {
  try {
    const inputs = parseInputs(env);
    const plan = await makePlan({ github, inputs });
    const lines =
      inputs.action === "prepare"
        ? await prepare({ github, cwd, inputs, plan })
        : await draftRelease({ github, cwd, inputs, plan });
    const title = `## ${inputs.action} ${plan.repo} ${plan.version}${inputs.dryRun ? " (dry run, nothing changed)" : ""}`;
    await core.summary.addRaw([title, "", ...lines].join("\n"), true).write();
  } catch (err) {
    core.setFailed(err.message);
  }
};

/** Read and validate the form fields, which arrive as environment variables. */
function parseInputs(env) {
  const inputs = {
    action: env.RELEASE_ACTION,
    repo: (env.RELEASE_REPO || "").trim(),
    releaseType: env.RELEASE_TYPE,
    version: (env.RELEASE_VERSION || "").trim().replace(/^v/, ""),
    commit: (env.RELEASE_COMMIT || "").trim(),
    picks: (env.RELEASE_CHERRY_PICKS || "").split(/[\s,]+/).filter(Boolean),
    stage: env.RELEASE_STAGE,
    dryRun: env.RELEASE_DRY_RUN !== "false",
    actor: env.RELEASE_ACTOR,
  };
  const check = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  check(ACTIONS.includes(inputs.action), `action must be one of: ${ACTIONS.join(", ")}.`);
  check(REPO_RE.test(inputs.repo), `repo must be a ${OWNER} repository name, e.g. keras-hub.`);
  check(RELEASE_TYPES.includes(inputs.releaseType), `release_type must be one of: ${RELEASE_TYPES.join(", ")}.`);
  check(STAGES.includes(inputs.stage), `stage must be one of: ${STAGES.join(", ")}.`);
  check(
    !inputs.version || VERSION_RE.test(inputs.version),
    `version "${inputs.version}" is not of the form 1.2.3, 1.2.3.dev0 or 1.2.3rc1.`
  );
  for (const sha of [inputs.commit, ...inputs.picks].filter(Boolean)) {
    check(SHA_RE.test(sha), `"${sha}" is not a commit hash.`);
  }
  check(inputs.actor, "The person who started the run is unknown.");
  return inputs;
}

/** Resolve the target repo, check the actor may release it, and settle the version. */
async function makePlan({ github, inputs }) {
  const owner = OWNER;
  const repo = inputs.repo;
  const { data: repoData } = await github.rest.repos.get({ owner, repo });
  const { data: access } = await github.rest.repos.getCollaboratorPermissionLevel({
    owner,
    repo,
    username: inputs.actor,
  });
  if (!["admin", "write"].includes(access.permission)) {
    throw new Error(`@${inputs.actor} needs write access to ${owner}/${repo} to release it.`);
  }
  // Commits are made as the person who started the run.
  const { data: user } = await github.rest.users.getByUsername({ username: inputs.actor });
  const authorEmail = `${user.id}+${inputs.actor}@users.noreply.github.com`;
  const tags = (await github.paginate(github.rest.repos.listTags, { owner, repo, per_page: 100 })).map(
    (tag) => tag.name
  );
  const version = inputs.version || nextVersion(tags, inputs.releaseType, inputs.stage);
  const tag = `v${version}`;
  if (tags.includes(tag)) {
    throw new Error(`Tag ${tag} already exists in ${owner}/${repo}.`);
  }
  const [major, minor] = version.split(".");
  const branch = `r${major}.${minor}`;
  return { owner, repo, version, tag, tags, branch, authorEmail, defaultBranch: repoData.default_branch };
}

const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Final releases (`vX.Y.Z` tags) as number triples, highest first. */
function finalVersions(tags) {
  return tags
    .map((tag) => FINAL_VERSION_RE.exec(tag.replace(/^v/, "")))
    .filter(Boolean)
    .map((match) => match.slice(1).map(Number))
    .sort((a, b) => compareVersions(b, a));
}

/**
 * Next version after the highest final release tag (`vX.Y.Z`).
 * major: X+1.0.0, minor: X.Y+1.0, patch: X.Y.Z+1. `dev` appends `.dev0`.
 */
function nextVersion(tags, releaseType, stage) {
  const finals = finalVersions(tags);
  if (finals.length === 0) {
    throw new Error("No vX.Y.Z release tag found to count from. Type the version yourself.");
  }
  const [major, minor, patch] = finals[0];
  const next = {
    major: [major + 1, 0, 0],
    minor: [major, minor + 1, 0],
    patch: [major, minor, patch + 1],
  }[releaseType];
  return next.join(".") + (stage === "dev" ? ".dev0" : "");
}

/** The highest final release tag below `version`: where its release notes start. */
function previousTag(tags, version) {
  const current = version.split(".").slice(0, 3).map((part) => parseInt(part, 10));
  const previous = finalVersions(tags).find((item) => compareVersions(item, current) < 0);
  return previous && `v${previous.join(".")}`;
}

/** Order `picks` as they appear in `mainline` (oldest first), without repeats. */
function sortPicks(mainline, picks) {
  const wanted = new Set(picks);
  const missing = picks.filter((sha) => !mainline.includes(sha));
  if (missing.length > 0) {
    throw new Error(`Not on the default branch, so cannot be cherry-picked: ${missing.join(", ")}.`);
  }
  return mainline.filter((sha) => wanted.has(sha));
}

/** Replace the `__version__ = ...` line. */
function bumpVersion(text, version) {
  if (!VERSION_LINE_RE.test(text)) {
    throw new Error("No `__version__ = ` line found in the version file.");
  }
  return text.replace(VERSION_LINE_RE, `__version__ = "${version}"`);
}

async function prepare({ github, cwd, inputs, plan }) {
  const { owner, repo, version, branch, defaultBranch } = plan;
  const branchExists = refExists(cwd, `origin/${branch}`);
  const mainline = git(cwd, ["rev-list", "--reverse", `origin/${defaultBranch}`]).split("\n");

  let base;
  if (branchExists) {
    if (inputs.commit) {
      throw new Error(`${branch} already exists, so \`commit\` does not apply. Leave it blank.`);
    }
    base = resolveCommit(cwd, `origin/${branch}`);
  } else {
    if (inputs.releaseType === "patch") {
      throw new Error(`A patch needs an existing release branch, and ${branch} does not exist.`);
    }
    base = resolveCommit(cwd, inputs.commit || `origin/${defaultBranch}`);
    if (!mainline.includes(base)) {
      throw new Error(`Commit ${base} is not on ${defaultBranch}.`);
    }
  }

  const prepBranch = `release-prep/${version}`;
  if (refExists(cwd, `origin/${prepBranch}`)) {
    throw new Error(
      `Branch ${prepBranch} already exists. Open a PR from it into ${branch}, or delete it and run again.`
    );
  }
  const picks = sortPicks(
    mainline,
    inputs.picks.map((sha) => resolveCommit(cwd, sha))
  );

  git(cwd, ["config", "user.name", inputs.actor]);
  git(cwd, ["config", "user.email", plan.authorEmail]);
  git(cwd, ["checkout", "--quiet", "--detach", base]);
  for (const sha of picks) {
    try {
      git(cwd, ["cherry-pick", "-x", sha]);
    } catch (err) {
      throw new Error(`Cherry-pick of ${sha} onto ${branch} failed. Resolve it by hand.\n${err.message}`);
    }
  }
  const versionFile = findVersionFile(cwd);
  const versionPath = path.join(cwd, versionFile);
  const before = fs.readFileSync(versionPath, "utf8");
  const after = bumpVersion(before, version);
  if (after !== before) {
    fs.writeFileSync(versionPath, after);
    git(cwd, ["commit", "--quiet", "-m", `Bump version to ${version}`, "--", versionFile]);
  }
  const needsPr = resolveCommit(cwd, "HEAD") !== base;
  if (branchExists && !needsPr) {
    throw new Error(`${branch} is already at ${version} and there is nothing to cherry-pick. Run draft-release.`);
  }

  const lines = [
    branchExists ? `- Release branch \`${branch}\` exists.` : `- Cut \`${branch}\` from \`${base}\`.`,
    ...picks.map((sha) => `- Cherry-pick \`${sha}\` ${git(cwd, ["log", "-1", "--format=%s", sha])}`),
    after !== before ? `- Set \`${versionFile}\` to \`${version}\`.` : `- \`${versionFile}\` is already \`${version}\`.`,
  ];
  if (inputs.dryRun) {
    return [...lines, needsPr ? `- Would open a PR into \`${branch}\`.` : "- No PR needed."];
  }

  if (!branchExists) {
    git(cwd, ["push", "--quiet", "origin", `${base}:refs/heads/${branch}`]);
  }
  if (!needsPr) {
    return [...lines, "- No PR needed. Run the panel with `draft-release` next."];
  }
  git(cwd, ["push", "--quiet", "origin", `HEAD:refs/heads/${prepBranch}`]);
  const { data: pr } = await github.rest.pulls.create({
    owner,
    repo,
    base: branch,
    head: prepBranch,
    title: `Prepare release ${version}`,
    body: [
      `Opened by the release panel for @${inputs.actor}.`,
      "",
      ...lines,
      "",
      "After this is merged, run the panel again with `draft-release`.",
    ].join("\n"),
  });
  return [...lines, `- Opened ${pr.html_url}. Merge it, then run the panel with \`draft-release\`.`];
}

async function draftRelease({ github, cwd, inputs, plan }) {
  const { owner, repo, version, tag, branch } = plan;
  if (!refExists(cwd, `origin/${branch}`)) {
    throw new Error(`Release branch ${branch} does not exist. Run prepare first.`);
  }
  const versionFile = findVersionFile(cwd, `origin/${branch}`);
  const text = git(cwd, ["show", `origin/${branch}:${versionFile}`]);
  if (bumpVersion(text, version) !== text) {
    throw new Error(`${versionFile} on ${branch} is not at ${version}. Merge the prepare PR first.`);
  }
  const releases = await github.paginate(github.rest.repos.listReleases, { owner, repo, per_page: 100 });
  const existing = releases.find((item) => item.tag_name === tag);
  if (existing) {
    throw new Error(`A release for ${tag} already exists: ${existing.html_url}`);
  }
  const prerelease = !FINAL_VERSION_RE.test(version);
  // Tag the commit that was just checked, and start the notes at the last final release.
  const target = resolveCommit(cwd, `origin/${branch}`);
  const previous = previousTag(plan.tags, version);
  if (inputs.dryRun) {
    return [`- Would draft ${prerelease ? "pre-release" : "release"} \`${tag}\` at \`${target}\` on \`${branch}\`.`];
  }
  const { data: notes } = await github.rest.repos.generateReleaseNotes({
    owner,
    repo,
    tag_name: tag,
    target_commitish: target,
    ...(previous && { previous_tag_name: previous }),
  });
  const { data: draft } = await github.rest.repos.createRelease({
    owner,
    repo,
    tag_name: tag,
    target_commitish: target,
    name: tag,
    body: notes.body,
    draft: true,
    prerelease,
  });
  return [`- Drafted ${draft.html_url}. Edit the notes, then click Publish to tag \`${tag}\` and upload to PyPI.`];
}

/** The single tracked `*version.py` that holds a `__version__ = ` line. */
function findVersionFile(cwd, ref) {
  let output = "";
  try {
    output = git(cwd, ["grep", "-lE", "^__version__ = ", ...(ref ? [ref] : []), "--", "*version.py"]);
  } catch (err) {
    // `git grep` exits 1 when nothing matches.
  }
  const prefix = ref ? `${ref}:` : "";
  const files = output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(prefix.length));
  if (files.length !== 1) {
    throw new Error(
      `Expected exactly one version.py with a \`__version__ = \` line, found: ${files.join(", ") || "none"}.`
    );
  }
  return files[0];
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function refExists(cwd, ref) {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`]);
    return true;
  } catch (err) {
    return false;
  }
}

function resolveCommit(cwd, ref) {
  try {
    return git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch (err) {
    throw new Error(`Commit ${ref} was not found in the repository.`);
  }
}

Object.assign(module.exports, { parseInputs, nextVersion, previousTag, sortPicks, bumpVersion });
