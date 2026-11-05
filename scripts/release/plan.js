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
 * release.yml `plan` job (no secrets; GITHUB_TOKEN with actions: read).
 *
 * - Refuses unless running from refs/heads/main and RELEASE_APP_SLUG is set.
 * - Validates every panel input. Inputs are read from `process.env` only
 *   (the workflow maps each `inputs.*` into `env:`), never interpolated.
 * - Run-signal half of the same-branch lock: refuses when another active
 *   release.yml run targets the same repo+branch, or an active publish.yml
 *   run targets a tag on the branch's X.Y line.
 *
 * Also exports the input reader and the re-run guard used by act/dispatch.
 */

const path = require("node:path");
const { RefusalError } = require("./lib/errors");
const { loadConfig, targetRepo } = require("./lib/config");
const { branchXY, checkConsistent } = require("./lib/version");
const pep440 = require("./lib/pep440");
const { parsePicks } = require("./lib/picks");
const { runConflicts } = require("./lib/lock");
const { Gh } = require("./lib/gh");
const { Report, escapeMd, writeSummary } = require("./lib/summary");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const REPOSITORIES = ["keras", "keras-hub", "keras-rs", "kinetic"];
const BOOL = ["true", "false"];
const CHOICES = {
  channel: ["dev", "stable"],
  kind: ["major", "patch"],
  release_mode: ["draft", "auto"],
  bump_master: BOOL,
  override_generated_tests: BOOL,
  dry_run: BOOL,
};
const ENV_NAMES = {
  repository: "RELEASE_REPOSITORY",
  channel: "RELEASE_CHANNEL",
  kind: "RELEASE_KIND",
  release_branch: "RELEASE_BRANCH",
  commit_sha: "RELEASE_COMMIT_SHA",
  version: "RELEASE_VERSION",
  cherry_picks: "RELEASE_CHERRY_PICKS",
  bump_master: "RELEASE_BUMP_MASTER",
  release_mode: "RELEASE_MODE",
  override_generated_tests: "RELEASE_OVERRIDE_GENERATED_TESTS",
  dry_run: "RELEASE_DRY_RUN",
};

function readInputs(env) {
  const inputs = {};
  for (const [key, name] of Object.entries(ENV_NAMES)) {
    inputs[key] = String(env[name] == null ? "" : env[name]).trim();
  }
  return inputs;
}

/** Refuses a "Re-run failed jobs" attempt: it would skip plan's lock. */
function assertFirstAttempt(env) {
  const attempt = String(env.GITHUB_RUN_ATTEMPT || "");
  if (attempt !== "1") {
    throw new RefusalError(
      `This is run attempt ${escapeMd(attempt || "(unknown)")}. Re-running ` +
      "jobs is not supported: it restarts after the plan job and skips the " +
      "same-branch lock.",
      "start a new run with Run workflow; it resumes where the last one stopped.");
  }
}

function refuseInput(what, value, next) {
  throw new RefusalError(`Invalid ${what}: "${escapeMd(value)}".`, next);
}

/** Returns the trimmed `vars.RELEASE_APP_SLUG`, or refuses when it is empty. */
function requireAppSlug(env) {
  const slug = String(env.RELEASE_APP_SLUG || "").trim();
  if (!slug) {
    throw new RefusalError("`vars.RELEASE_APP_SLUG` is empty.",
      "ask an admin to set the RELEASE_APP_SLUG repository variable.");
  }
  return slug;
}

function assertKnownRepository(repository,
  next = `pick one of ${REPOSITORIES.join(", ")}.`) {
  if (!REPOSITORIES.includes(repository)) refuseInput("repository", repository, next);
}

/** Reads, checks and returns `{ inputs, config, xy }`. */
function loadInputsAndConfig(env, rootDir) {
  const inputs = readInputs(env);
  assertKnownRepository(inputs.repository);
  const config = loadConfig(inputs.repository, rootDir);
  for (const [key, allowed] of Object.entries(CHOICES)) {
    if (!allowed.includes(inputs[key])) {
      refuseInput(key, inputs[key], `use one of ${allowed.join(", ")}.`);
    }
  }
  const xy = branchXY(inputs.release_branch, config.release_branch_pattern);
  if (inputs.commit_sha) {
    if (!/^[0-9a-f]{7,40}$/.test(inputs.commit_sha)) {
      refuseInput("commit_sha", inputs.commit_sha,
        "give a hex commit sha from the default branch.");
    }
    if (inputs.kind !== "major") {
      throw new RefusalError("`commit_sha` applies only to kind=major with a " +
        "new release branch.", "clear commit_sha and run again.");
    }
  }
  if (inputs.version) {
    try {
      pep440.parse(inputs.version);
    } catch (err) {
      refuseInput("version", inputs.version,
        "use X.Y.Z or X.Y.Z.devN without a prefix, or leave it blank.");
    }
    checkConsistent(inputs.version, {
      kind: inputs.kind, channel: inputs.channel, xy,
    });
  }
  parsePicks(inputs.cherry_picks);
  return { inputs, config, xy };
}

function failWith(core, report, err) {
  report.refuse(err);
  core.setFailed(err.next ? `${err.message} Next: ${err.next}` : err.message);
}

/**
 * Returns [owner, repo] from the config and refuses if the owner/name the
 * App token was minted for (plan's outputs, passed back in as env) differ.
 */
function resolveTarget(config, context, tokenOwner, tokenName) {
  const target = targetRepo(config, context.repo.owner);
  const scoped = `${String(tokenOwner || "")}/${String(tokenName || "")}`;
  if (scoped !== target) {
    throw new RefusalError(`The App token is scoped to \`${escapeMd(scoped)}\`, ` +
      `but the config targets \`${target}\`.`,
      "start a new run with Run workflow; do not re-run single jobs.");
  }
  return target.split("/");
}

async function main({ github, context, core, env = process.env,
  rootDir = ROOT_DIR }) {
  const report = new Report("Release plan");
  report.setHeader(null, "plan");
  try {
    if (context.ref !== "refs/heads/main") {
      throw new RefusalError(`The panel ran from ${escapeMd(context.ref)}. ` +
        "Only reviewed code on main can reach the bot key and PyPI.",
        "choose `main` in the branch picker and run again.");
    }
    requireAppSlug(env);
    const { inputs, config } = loadInputsAndConfig(env, rootDir);
    report.setHeader(inputs.version || "auto", "plan");
    const target = targetRepo(config, context.repo.owner);
    const gh = new Gh({
      github, owner: context.repo.owner, repo: context.repo.repo,
    });
    const runs = [
      ...await gh.listActiveRuns("release.yml"),
      ...await gh.listActiveRuns("publish.yml"),
    ];
    const conflicts = runConflicts({
      runs, selfRunId: context.runId, repository: inputs.repository,
      branch: inputs.release_branch, pattern: config.release_branch_pattern,
      prefix: config.tag_prefix,
    });
    if (conflicts.length > 0) {
      const list = conflicts.map(({ run, reason }) =>
        `- ${run.workflow} run ${run.id} (${run.status}): ${escapeMd(reason)}`);
      throw new RefusalError(
        `Another active run holds the lock for ${escapeMd(inputs.repository)} ` +
        `${escapeMd(inputs.release_branch)}:\n${list.join("\n")}`,
        "wait for that run to finish, then click Run workflow again.");
    }
    const [owner, name] = target.split("/");
    core.setOutput("target_owner", owner);
    core.setOutput("target_name", name);
    report.add(`Inputs valid. Target: \`${target}\`. No other active run ` +
      `holds ${escapeMd(inputs.release_branch)}.`);
    report.setNext("the act job runs next and reports the detected step.");
  } catch (err) {
    failWith(core, report, err);
  }
  await writeSummary(core, report);
}

module.exports = {
  ENV_NAMES,
  REPOSITORIES,
  ROOT_DIR,
  assertFirstAttempt,
  assertKnownRepository,
  failWith,
  loadInputsAndConfig,
  main,
  readInputs,
  requireAppSlug,
  resolveTarget,
};
