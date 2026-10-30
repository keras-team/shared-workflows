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

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig, validateConfig, targetRepo, SCHEMA, DEFAULT_ROOT } = require("./config");
const { RefusalError } = require("./errors");

const REPOS = ["keras-hub", "keras", "keras-rs", "kinetic"];

function readReal(name) {
  return JSON.parse(fs.readFileSync(path.join(DEFAULT_ROOT, "release", "repos", `${name}.json`), "utf8"));
}

/** Writes `config` as release/repos/<name>.json under a fresh temp root. */
function withConfig(config, fn, name = "demo") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sw-config-"));
  try {
    fs.mkdirSync(path.join(root, "release", "repos"), { recursive: true });
    const text = typeof config === "string" ? config : JSON.stringify(config);
    fs.writeFileSync(path.join(root, "release", "repos", `${name}.json`), text);
    return fn(root, name);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function refusesWith(config, re) {
  withConfig(config, (root, name) => {
    assert.throws(() => loadConfig(name, root), (e) => e instanceof RefusalError && re.test(e.message));
  });
}

test("every shipped config is valid; only keras-hub is enabled", () => {
  for (const name of REPOS) {
    const c = readReal(name);
    validateConfig(c, name);
    assert.equal(c.enabled, name === "keras-hub", name);
    assert.equal(c.tag_prefix, "v");
    assert.deepEqual(Object.keys(c).sort(), Object.keys(SCHEMA).sort(), name);
  }
  assert.equal(readReal("keras").default_branch, "master");
  assert.equal(readReal("keras-rs").default_branch, "main");
  assert.equal(readReal("kinetic").default_branch, "main");
});

test("keras-hub config matches the target repo facts", () => {
  const c = loadConfig("keras-hub");
  assert.equal(c.github_repo, "keras-team/keras-hub");
  assert.equal(c.default_branch, "master");
  assert.deepEqual(c.version_files, ["keras_hub/src/version.py"]);
  assert.deepEqual(c.packages, ["keras-hub", "keras-nlp"]);
  assert.deepEqual(c.dist_dirs, ["dist/", "keras_nlp/dist/"]);
  assert.equal(c.build_setup_command, "pip install -r requirements.txt");
  assert.equal(c.build_command, "python pip_build.py");
  assert.equal(c.legacy_publish_workflow, "publish-to-pypi.yml");
});

test("disabled repos are refused by loadConfig", () => {
  for (const name of ["keras", "keras-rs", "kinetic"]) {
    assert.throws(() => loadConfig(name), (e) => e instanceof RefusalError && /not enabled/.test(e.message));
  }
});

test("unknown and missing repos are refused, names are validated", () => {
  assert.throws(() => loadConfig("nope"), /No release config/);
  assert.throws(() => loadConfig("../keras-hub"), /not a valid repository name/);
  assert.throws(() => loadConfig(""), /not a valid repository name/);
});

test("loader rejections", () => {
  const base = { ...readReal("keras-hub") };
  refusesWith("{not json", /not valid JSON/);
  refusesWith("[]", /not a JSON object/);
  refusesWith({ ...base, extra: 1 }, /unknown field\(s\): extra/);
  for (const field of Object.keys(SCHEMA)) {
    const c = { ...base };
    delete c[field];
    refusesWith(c, new RegExp(`missing required field "${field}"`));
  }
  refusesWith({ ...base, enabled: "true" }, /"enabled" must be/);
  refusesWith({ ...base, tag_prefix: "" }, /"tag_prefix" must be exactly "v"/);
  refusesWith({ ...base, tag_prefix: "keras-v" }, /"tag_prefix"/);
  refusesWith({ ...base, version_files: [] }, /"version_files"/);
  refusesWith({ ...base, version_files: "keras_hub/src/version.py" }, /"version_files"/);
  refusesWith({ ...base, version_files: ["../x.py"] }, /"version_files"/);
  refusesWith({ ...base, version_files: ["/etc/passwd"] }, /"version_files"/);
  refusesWith({ ...base, packages: [] }, /"packages"/);
  refusesWith({ ...base, dist_dirs: ["../dist"] }, /"dist_dirs"/);
  refusesWith({ ...base, github_repo: "keras-hub" }, /"github_repo"/);
  refusesWith({ ...base, legacy_publish_workflow: "" }, /"legacy_publish_workflow"/);
  refusesWith({ ...base, legacy_publish_workflow: "../x.yml" }, /"legacy_publish_workflow"/);
  refusesWith({ ...base, release_branch_pattern: "^r(\\d+$" }, /not a valid regex/);
  refusesWith({ ...base, release_branch_pattern: "r(\\d+)\\.(\\d+)" }, /anchored/);
  refusesWith({ ...base, release_branch_pattern: "^r(\\d+)$" }, /exactly two capture groups/);
  refusesWith({ ...base, release_branch_pattern: "^r(\\d+)\\.(\\d+)(x)?$" }, /exactly two/);
  refusesWith({ ...base, release_branch_pattern: "^(.*)(.*)$" }, /default_branch matches/);
});

test("legacy_publish_workflow may be explicit null, never absent", () => {
  const base = { ...readReal("keras-hub"), legacy_publish_workflow: null };
  withConfig(base, (root, name) => {
    assert.equal(loadConfig(name, root).legacy_publish_workflow, null);
  });
  const absent = { ...base };
  delete absent.legacy_publish_workflow;
  refusesWith(absent, /missing required field "legacy_publish_workflow"/);
});

test("non-capturing groups do not count as X/Y groups", () => {
  const c = { ...readReal("keras-hub"), release_branch_pattern: "^(?:rel-)?r(\\d+)\\.(\\d+)$" };
  withConfig(c, (root, name) => assert.ok(loadConfig(name, root)));
});

test("targetRepo maps forks and never resolves to keras-team for a fork", () => {
  const c = readReal("keras-hub");
  assert.equal(targetRepo(c, "keras-team"), "keras-team/keras-hub");
  assert.equal(targetRepo(c, "Keras-Team"), "keras-team/keras-hub");
  assert.equal(targetRepo(c, "laxmareddyp"), "laxmareddyp/keras-hub");
  for (const owner of ["laxmareddyp", "keras-team-fork", "evil-keras-team", "a"]) {
    assert.ok(!targetRepo(c, owner).toLowerCase().startsWith("keras-team/"), owner);
  }
  assert.throws(() => targetRepo(c, ""), /Invalid repository owner/);
  assert.throws(() => targetRepo(c, "a/b"), /Invalid repository owner/);
  assert.throws(() => targetRepo({}, "keras-team"), /github_repo/);
});
