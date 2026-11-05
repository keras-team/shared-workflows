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
 * Loads and validates release/repos/<name>.json, and maps a config to the
 * repo a run targets (the fork override of plan section 3). This is the one
 * module both release.yml and publish.yml use for that mapping.
 */

const fs = require("node:fs");
const path = require("node:path");
const { RefusalError } = require("./errors");

const DEFAULT_ROOT = path.resolve(__dirname, "..", "..", "..");
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const WORKFLOW_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;
const UPSTREAM_OWNER = "keras-team";

const FIX_NEXT = (name) =>
  `fix release/repos/${name}.json in keras-team/shared-workflows (via a ` +
  "reviewed PR), then run the panel again.";

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

function isRelativePath(v) {
  return (
    isNonEmptyString(v) &&
    !v.startsWith("/") &&
    !v.includes("\\") &&
    !v.split("/").includes("..")
  );
}

function nonEmptyArrayOf(check) {
  return (v) => Array.isArray(v) && v.length > 0 && v.every(check);
}

/** Field name -> [validator, human description]. Every field is required. */
const SCHEMA = {
  enabled: [(v) => typeof v === "boolean", "a boolean"],
  github_repo: [(v) => typeof v === "string" && REPO_RE.test(v), '"owner/name"'],
  default_branch: [isNonEmptyString, "a non-empty string"],
  release_branch_pattern: [isNonEmptyString, "a regex string"],
  tag_prefix: [(v) => v === "v", 'exactly "v"'],
  version_files: [nonEmptyArrayOf(isRelativePath), "a non-empty array of relative paths"],
  packages: [nonEmptyArrayOf(isNonEmptyString), "a non-empty array of strings"],
  import_names: [nonEmptyArrayOf(isNonEmptyString), "a non-empty array of strings"],
  build_setup_command: [isNonEmptyString, "a non-empty string"],
  build_command: [isNonEmptyString, "a non-empty string"],
  dist_dirs: [nonEmptyArrayOf(isRelativePath), "a non-empty array of relative paths"],
  dev_suffix_on_master: [(v) => typeof v === "string", "a string (may be empty)"],
  smoke_snippet: [isNonEmptyString, "a non-empty string"],
  backends: [nonEmptyArrayOf(isNonEmptyString), "a non-empty array of strings"],
  legacy_publish_workflow: [
    (v) => v === null || (typeof v === "string" && WORKFLOW_RE.test(v)),
    "a workflow file name or explicit null",
  ],
};

function countCaptureGroups(re) {
  // Appending an always-matching alternative makes exec("") return one slot
  // per capture group.
  return new RegExp(`${re.source}|`).exec("").length - 1;
}

/**
 * Validates a parsed config object. Does not look at `enabled` beyond its
 * type, so disabled configs can be checked too. Returns the config.
 */
function validateConfig(config, name) {
  const next = FIX_NEXT(name);
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new RefusalError(`Config ${name}.json is not a JSON object.`, next);
  }
  const unknown = Object.keys(config).filter((k) => !(k in SCHEMA));
  if (unknown.length) {
    throw new RefusalError(
      `Config ${name}.json has unknown field(s): ${unknown.join(", ")}.`,
      next,
    );
  }
  for (const [field, [check, desc]] of Object.entries(SCHEMA)) {
    if (!Object.prototype.hasOwnProperty.call(config, field)) {
      const hint =
        field === "legacy_publish_workflow"
          ? " (set it to explicit null only after the legacy file is deleted)"
          : "";
      throw new RefusalError(
        `Config ${name}.json is missing required field "${field}"${hint}.`,
        next,
      );
    }
    if (!check(config[field])) {
      throw new RefusalError(
        `Config ${name}.json field "${field}" must be ${desc}.`,
        next,
      );
    }
  }
  const pattern = config.release_branch_pattern;
  let re;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    throw new RefusalError(
      `Config ${name}.json release_branch_pattern is not a valid regex: ${e.message}`,
      next,
    );
  }
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
    throw new RefusalError(
      `Config ${name}.json release_branch_pattern must be anchored with ^ and $.`,
      next,
    );
  }
  if (countCaptureGroups(re) !== 2) {
    throw new RefusalError(
      `Config ${name}.json release_branch_pattern must have exactly two ` +
        "capture groups (X and Y).",
      next,
    );
  }
  if (re.test(config.default_branch)) {
    throw new RefusalError(
      `Config ${name}.json default_branch matches release_branch_pattern.`,
      next,
    );
  }
  return config;
}

/**
 * Reads, validates and returns release/repos/<name>.json. Refuses repos with
 * `enabled: false`.
 */
function loadConfig(name, rootDir = DEFAULT_ROOT) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new RefusalError(
      `"${name}" is not a valid repository name.`,
      "pick one of the repositories offered by the panel.",
    );
  }
  const file = path.join(rootDir, "release", "repos", `${name}.json`);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new RefusalError(
      `No release config for "${name}" (release/repos/${name}.json).`,
      "pick one of the repositories offered by the panel.",
    );
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (e) {
    throw new RefusalError(
      `Config ${name}.json is not valid JSON: ${e.message}`,
      FIX_NEXT(name),
    );
  }
  validateConfig(config, name);
  if (config.enabled !== true) {
    throw new RefusalError(
      `Releases for "${name}" are not enabled (release/repos/${name}.json has ` +
        '"enabled": false).',
      "ask a shared-workflows maintainer to enable the repo once its rollout " +
        "steps in RELEASE_PROCESS.md are done.",
    );
  }
  return config;
}

/**
 * Plan section 3: upstream runs target config.github_repo; a run in a fork of
 * shared-workflows targets the same-named repo under the fork owner. Owners
 * are compared case-insensitively, as GitHub does, so a fork owner can never
 * be mistaken for keras-team or vice versa.
 */
function targetRepo(config, repositoryOwner) {
  if (typeof repositoryOwner !== "string" || !OWNER_RE.test(repositoryOwner)) {
    throw new Error(`Invalid repository owner "${repositoryOwner}".`);
  }
  if (!config || typeof config.github_repo !== "string" || !REPO_RE.test(config.github_repo)) {
    throw new Error("Config has no valid github_repo.");
  }
  if (repositoryOwner.toLowerCase() === UPSTREAM_OWNER) {
    return config.github_repo;
  }
  return `${repositoryOwner}/${config.github_repo.split("/")[1]}`;
}

module.exports = { loadConfig, validateConfig, targetRepo, SCHEMA, DEFAULT_ROOT, LOGIN_RE: OWNER_RE };
