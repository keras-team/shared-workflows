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
 * Test doubles shared by the release *.test.js files (not itself a test):
 * a fixture-backed fake octokit that records every call, a fake git with a
 * call spy, a fake `core`, a temp config root, and a keras-hub-like fixture.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BOT = "keras-release[bot]";
const SLUG = "keras-release";
const VERSION_FILE = "keras_hub/src/version.py";
const SHA = {
  master: "1".repeat(40), b0: "2".repeat(40), ms: "3".repeat(40),
  m1: "4".repeat(40), p0: "5".repeat(40), tagobj: "6".repeat(40),
  b1: "7".repeat(40), other: "8".repeat(40), m0: "9".repeat(40),
};

/**
 * Every method name that changes remote state. The fake has no merge method
 * at all, so a merge call fails the test with a TypeError.
 */
const WRITE_METHODS = new Set([
  "git.createRef", "git.updateRef", "git.deleteRef", "git.createTag",
  "pulls.create", "pulls.update",
  "repos.createRelease", "repos.updateRelease", "repos.deleteRelease",
  "repos.createOrUpdateFileContents", "actions.createWorkflowDispatch",
  "issues.addLabels", "issues.createComment",
]);

const versionText = (v) => `__version__ = "${v}"\n`;

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function need(value, status = 404) {
  if (value === undefined || value === null) throw httpError(status);
  return value;
}

function handlers(f, fail) {
  return {
    repos: {
      getCollaboratorPermissionLevel: ({ username }) =>
        ({ permission: need(f.permissions[username]) }),
      getContent: ({ path: p, ref }) => ({
        type: "file", encoding: "base64",
        content: Buffer.from(need(f.files[`${ref}:${p}`])).toString("base64"),
      }),
      getBranch: ({ branch }) => ({ commit: { sha: need(f.branches[branch]) } }),
      getCommit: ({ ref }) => {
        const sha = f.branches[ref] || ref;
        const c = need(f.commits[sha]);
        return { sha, parents: c.parents.map((s) => ({ sha: s })),
          commit: { message: c.message || "" } };
      },
      compareCommitsWithBasehead: ({ basehead }) => {
        const c = need(f.compares[basehead]);
        const commits = (c.commits || []).map((x) =>
          ({ sha: x.sha, commit: { message: x.message } }));
        return { status: c.status, commits, total_commits: commits.length };
      },
      listCommits: () => f.history.map((h) =>
        ({ sha: h.sha, parents: h.parents.map((s) => ({ sha: s })) })),
      listPullRequestsAssociatedWithCommit: ({ commit_sha }) =>
        (f.commitPulls[commit_sha] || []).map((n) => ({ number: n })),
      listReleases: () => f.releases,
      listBranches: () => Object.keys(f.branches).map((name) => ({ name })),
      createRelease: (p) => {
        if (fail.createRelease) throw httpError(500);
        return { id: 4242, html_url: "https://example.test/release", ...p };
      },
      updateRelease: (p) => ({ html_url: "https://example.test/release", ...p }),
      generateReleaseNotes: (p) => ({ name: p.tag_name, body: "Generated notes" }),
    },
    git: {
      listMatchingRefs: ({ ref }) => f.refs.filter((r) => r.ref.startsWith(`refs/${ref}`)),
      getRef: ({ ref }) => need(f.refs.find((r) => r.ref === `refs/${ref}`)),
      getTag: ({ tag_sha }) => need(f.tagObjects[tag_sha]),
      createRef: (p) => ({ ref: p.ref }),
    },
    pulls: {
      list: ({ base, state }) => f.pulls.filter((p) =>
        p.base.ref === base && (state === "all" || p.state === state)),
      get: ({ pull_number }) => need(f.pulls.find((p) => p.number === pull_number)),
      create: () => ({ number: 9000, html_url: "https://example.test/pull/9000" }),
    },
    issues: {
      listEvents: ({ issue_number }) => f.events[issue_number] || [],
    },
    actions: {
      getWorkflow: ({ workflow_id }) => {
        const w = f.workflows[workflow_id];
        if (!w || w.status !== 200) throw httpError(w ? w.status : 404);
        return { state: w.state };
      },
      listWorkflowRuns: ({ workflow_id, status }) => ({
        workflow_runs: (f.runs[workflow_id] || []).filter((r) => r.status === status),
      }),
      createWorkflowDispatch: () => ({}),
    },
  };
}

/** Fake octokit. `calls` records `{ name, params }` for every REST call. */
function fakeGithub(fixture, fail = {}) {
  const f = {
    branches: {}, files: {}, refs: [], tagObjects: {}, releases: [],
    pulls: [], events: {}, permissions: {}, workflows: {}, runs: {},
    commits: {}, commitPulls: {}, compares: {}, history: [], ...fixture,
  };
  const calls = [];
  const rest = {};
  for (const [ns, methods] of Object.entries(handlers(f, fail))) {
    rest[ns] = {};
    for (const [name, fn] of Object.entries(methods)) {
      rest[ns][name] = async (params) => {
        calls.push({ name: `${ns}.${name}`, params });
        return { status: 200, data: fn(params) };
      };
    }
  }
  const items = (data) => Array.isArray(data) ? data : data.workflow_runs;
  const paginate = async (fn, params) => items((await fn(params)).data);
  paginate.iterator = async function* iterator(fn, params) {
    const all = items((await fn(params)).data);
    for (let i = 0; i < all.length; i += 100) yield { data: all.slice(i, i + 100) };
  };
  const github = { rest, paginate };
  return {
    github, calls,
    called: (name) => calls.filter((c) => c.name === name),
    writes: () => calls.filter((c) => WRITE_METHODS.has(c.name)),
  };
}

/** Fake git; `respond(args)` may return stdout or throw. */
function fakeGit(respond = () => "") {
  const calls = [];
  const fn = (args, opts) => {
    calls.push({ args, opts });
    const out = respond(args, opts);
    return out === undefined ? "" : out;
  };
  return { fn, calls, pushes: () => calls.filter((c) => c.args[0] === "push") };
}

function fakeCore() {
  const core = { outputs: {}, failed: null, logs: [], summaryText: "" };
  core.setOutput = (k, v) => { core.outputs[k] = v; };
  core.setFailed = (m) => { core.failed = m; };
  core.info = (m) => core.logs.push(m);
  let buffer = "";
  core.summary = {
    addRaw(text) { buffer += text; return this; },
    async write() { core.summaryText = buffer; },
  };
  return core;
}

const CONFIG = {
  enabled: true,
  github_repo: "keras-team/keras-hub",
  default_branch: "master",
  release_branch_pattern: "^r(\\d+)\\.(\\d+)$",
  tag_prefix: "v",
  version_files: [VERSION_FILE],
  packages: ["keras-hub", "keras-nlp"],
  import_names: ["keras_hub", "keras_nlp"],
  build_setup_command: "pip install -r requirements.txt",
  build_command: "python pip_build.py",
  dist_dirs: ["dist/", "keras_nlp/dist/"],
  dev_suffix_on_master: ".dev0",
  smoke_snippet: "import keras_hub, keras_nlp",
  backends: ["tensorflow", "jax", "torch"],
  legacy_publish_workflow: "publish-to-pypi.yml",
};

/** Temp root holding release/repos/keras-hub.json (with overrides). */
function configRoot(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-cfg-"));
  fs.mkdirSync(path.join(root, "release", "repos"), { recursive: true });
  fs.writeFileSync(path.join(root, "release", "repos", "keras-hub.json"),
    JSON.stringify({ ...CONFIG, ...overrides }, null, 2));
  return root;
}

const context = (over = {}) => ({
  repo: { owner: "keras-team", repo: "shared-workflows" },
  ref: "refs/heads/main", runId: 1, serverUrl: "https://github.com", ...over,
});

function panelEnv(over = {}) {
  return {
    RELEASE_REPOSITORY: "keras-hub", RELEASE_CHANNEL: "stable",
    RELEASE_KIND: "patch", RELEASE_BRANCH: "r0.33", RELEASE_COMMIT_SHA: "",
    RELEASE_VERSION: "", RELEASE_CHERRY_PICKS: "", RELEASE_BUMP_MASTER: "false",
    RELEASE_MODE: "auto", RELEASE_OVERRIDE_GENERATED_TESTS: "false",
    RELEASE_DRY_RUN: "false", RELEASE_APP_SLUG: SLUG,
    RELEASE_TRIGGERING_ACTOR: "alice", RELEASE_TARGET_OWNER: "keras-team",
    RELEASE_TARGET_NAME: "keras-hub", GITHUB_RUN_ATTEMPT: "1",
    RELEASE_APP_TOKEN: "test-token", RUNNER_TEMP: os.tmpdir(),
    ...over,
  };
}

const releaseObj = (id, tag, sha, extra = {}) => ({
  id, tag_name: tag, draft: false, prerelease: false, target_commitish: sha,
  author: { login: BOT }, ...extra,
});

/** A bot bump PR into r0.33. */
function bumpPr(number, v, extra = {}) {
  return {
    number, state: "closed", merged_at: null, merge_commit_sha: null,
    merged_by: null, head: { ref: `release-tool/bump-${v}`,
      repo: { full_name: "keras-team/keras-hub" } },
    base: { ref: "r0.33" }, user: { login: BOT }, labels: [], body: "",
    ...extra,
  };
}

/** r0.33 at b0 (0.33.0, tagged and released); master at 0.34.0.dev0. */
function baseFixture() {
  return {
    branches: { "master": SHA.master, "r0.33": SHA.b0 },
    files: {
      [`${SHA.master}:${VERSION_FILE}`]: versionText("0.34.0.dev0"),
      [`${SHA.b0}:${VERSION_FILE}`]: versionText("0.33.0"),
    },
    refs: [{ ref: "refs/tags/v0.33.0", object: { type: "commit", sha: SHA.b0 } }],
    releases: [releaseObj(1, "v0.33.0", SHA.b0)],
    pulls: [{
      number: 101, state: "closed", merged: true, merged_at: "2026-09-01T00:00:00Z",
      merge_commit_sha: SHA.m1, commits: 1, title: "Fix *thing* <x>",
      head: { ref: "fix", repo: { full_name: "bob/keras-hub" } },
      base: { ref: "master" }, user: { login: "bob" }, labels: [], body: "",
    }],
    commits: {
      [SHA.m1]: { parents: [SHA.p0], message: "Fix *thing* <x> (#101)" },
      [SHA.master]: { parents: [SHA.m1], message: "Tip" },
    },
    history: [
      { sha: SHA.master, parents: [SHA.m1] },
      { sha: SHA.m1, parents: [SHA.p0] },
      { sha: SHA.p0, parents: [] },
    ],
    compares: {
      "r0.33...master": { status: "diverged",
        commits: [{ sha: SHA.m1, message: "Fix *thing* <x> (#101)" }] },
      "master...r0.33": { status: "diverged", commits: [] },
    },
    permissions: { alice: "write" },
    workflows: { "publish-to-pypi.yml": { status: 200, state: "disabled_manually" } },
  };
}

module.exports = {
  BOT, CONFIG, SHA, SLUG, VERSION_FILE, WRITE_METHODS,
  baseFixture, bumpPr, configRoot, context, fakeCore, fakeGit, fakeGithub,
  httpError, panelEnv, releaseObj, versionText,
};
