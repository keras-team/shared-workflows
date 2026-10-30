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
const { detect, checkCommitShaVersion, bumpVersion, draftMapsToLine } = require("./detect");
const { loadConfig } = require("./config");
const { refusalMatching: refusal } = require("./errors");

const CONFIG = loadConfig("keras-hub");
const { BOT } = require("../test_support");
const sha = (c) => c.repeat(40);

const tag = (v, s = sha("0")) => ({ name: `v${v}`, sha: s });
const rel = (v, over = {}) => ({
  id: 1, tag_name: `v${v}`, draft: false, prerelease: v.includes("dev"),
  target_commitish: sha("a"), author_login: BOT, ...over,
});
const draft = (v, over = {}) => rel(v, { draft: true, ...over });
const pr = (v, over = {}) => ({
  number: 10, state: "closed", merged: true, merge_commit_sha: sha("a"),
  head_ref: `release-tool/bump-${v}`, head_repo_full_name: "keras-team/keras-hub",
  base_ref: "r0.33", author_login: BOT, merged_by_login: "alice", body: "",
  labels: [], abandoned_by_writer: false, ...over,
});
const openPr = (v, over = {}) => pr(v, { state: "open", merged: false, merge_commit_sha: null, ...over });

function run(state = {}, inputs = {}) {
  return detect({
    state: {
      branch: "r0.33", branchExists: true, headSha: sha("f"), versionAtHead: "0.33.0.dev0",
      defaultBranchVersion: "0.34.0.dev0", tags: [tag("0.33.0.dev0")], releases: [rel("0.33.0.dev0")],
      prs: [], pickedPrNumbers: new Set(), pypiVersions: new Set(["0.33.0.dev0"]), ...state,
    },
    inputs: {
      repository: "keras-hub", channel: "dev", kind: "major", release_branch: "r0.33",
      commit_sha: "", version: "", cherry_picks: "", bump_master: "false", release_mode: "auto",
      override_generated_tests: "false", dry_run: "true", ...inputs,
    },
    config: CONFIG,
    botLogin: BOT,
  });
}

test("step 1: typed V with a non-draft release -> already-released", () => {
  const d = run({}, { version: "0.33.0.dev0" });
  assert.equal(d.step, "already-released");
  assert.equal(d.release.tag_name, "v0.33.0.dev0");
  assert.equal(d.tag, "v0.33.0.dev0");
});

test("blank V never resolves to already-released", () => {
  assert.equal(run().step, "prepare");
  assert.equal(run().version, "0.33.0.dev1");
  // Inconsistent data (a release whose tag is missing) still never auto-resolves.
  assert.throws(() => run({ releases: [rel("0.33.0.dev0"), rel("0.33.0.dev1")] }), refusal(/already released/));
});

test("step 2: merged bump-V PR + draft vV -> one candidate -> publish", () => {
  const d = run({ prs: [pr("0.33.0.dev1")], releases: [rel("0.33.0.dev0"), draft("0.33.0.dev1")] });
  assert.equal(d.step, "publish");
  assert.equal(d.version, "0.33.0.dev1");
  assert.equal(d.draft.tag_name, "v0.33.0.dev1");
});

test("step 3: tag at merge sha without release -> resume-continue (not stale)", () => {
  const d = run({ prs: [pr("0.33.0.dev1")], tags: [tag("0.33.0.dev0"), tag("0.33.0.dev1", sha("a"))] });
  assert.equal(d.step, "resume-continue");
  assert.equal(d.version, "0.33.0.dev1");
  assert.equal(d.pr.number, 10);
  assert.deepEqual(d.stale, []);
});

test("tag at merge sha of a human-authored PR is not in flight", () => {
  const state = { prs: [pr("0.33.0.dev1", { author_login: "mallory" })], tags: [tag("0.33.0.dev0"), tag("0.33.0.dev1", sha("a"))] };
  const d = run(state, { version: "", channel: "dev" });
  assert.equal(d.version, "0.33.0.dev2");
  assert.deepEqual(d.stale, [10]);
});

test("step 4: merged bump-V PR not yet tagged -> continue", () => {
  const d = run({ prs: [pr("0.33.0.dev1")] });
  assert.equal(d.step, "continue");
  assert.equal(d.pr.number, 10);
});

test("step 5: open bump-V PR -> wait; in-flight version reused over computed", () => {
  const d = run({ prs: [openPr("0.33.0.dev3", { number: 42 })] });
  assert.equal(d.step, "wait");
  assert.equal(d.version, "0.33.0.dev3");
  assert.equal(d.pr.number, 42);
});

test("step 6: version files at head == V and zero picks -> fast-path", () => {
  assert.equal(run({ versionAtHead: "0.33.0.dev1" }).step, "fast-path");
  assert.equal(run({ versionAtHead: "0.33.0.dev1" }, { cherry_picks: "#5" }).step, "prepare");
});

test("step 7: otherwise -> prepare (F1: picks before X.Y.0)", () => {
  const d = run({}, { cherry_picks: "#3101, #3110" });
  assert.equal(d.step, "prepare");
  assert.equal(d.version, "0.33.0.dev1");
});

test("prepare-only inputs given in a non-prepare step -> refused", () => {
  const state = { prs: [openPr("0.33.0.dev1")] };
  assert.throws(() => run(state, { cherry_picks: "#5" }), refusal(/detected step is wait.*cherry_picks/));
  assert.throws(() => run(state, { commit_sha: sha("c") }), refusal(/commit_sha/));
  assert.throws(() => run(state, { bump_master: "true" }), refusal(/bump_master/));
  assert.throws(() => run({ versionAtHead: "0.33.0.dev1" }, { bump_master: "true" }), refusal(/fast-path/));
  assert.throws(() => run({ prs: [pr("0.33.0.dev1")] }, { bump_master: "true" }), refusal(/continue/));
});

test("in-flight for a different version than typed -> refused", () => {
  const state = { prs: [openPr("0.33.0.dev1")] };
  assert.throws(() => run(state, { version: "0.33.0.dev2" }), refusal(/0.33.0.dev1 is in flight/));
  assert.throws(() => run(state, { version: "0.33.0.dev0" }), refusal(/0.33.0.dev1 is in flight/));
  assert.equal(run(state, { version: "v0.33.0.dev1" }).step, "wait");
});

test("two distinct in-flight versions -> refused and listed", () => {
  const state = { prs: [openPr("0.33.0.dev1")], releases: [rel("0.33.0.dev0"), draft("0.33.0.dev2")] };
  assert.throws(() => run(state), refusal(/0.33.0.dev1, 0.33.0.dev2/));
});

test("old release-less tag on the line is not in flight (r0.32 v0.32.0.dev0)", () => {
  const state = { branch: "r0.32", versionAtHead: "0.32.0.dev0", tags: [tag("0.32.0.dev0")], releases: [] };
  assert.equal(run(state).version, "0.32.0.dev1");
  assert.equal(run(state, { channel: "stable" }).version, "0.32.0");
});

test("stale merged bump PRs are ignored and listed; completed ones are not", () => {
  const state = {
    tags: [tag("0.33.0.dev0"), tag("0.33.0.dev1", sha("b")), tag("0.33.0.dev2", sha("c"))],
    releases: [rel("0.33.0.dev0"), rel("0.33.0.dev2")],
    prs: [
      pr("0.32.9", { number: 1, base_ref: "r0.32" }),
      pr("0.33.0.dev0", { number: 2, merge_commit_sha: sha("0") }),
      pr("0.33.0.dev1", { number: 3, merge_commit_sha: sha("a") }),
      pr("0.33.0.dev2", { number: 4, merge_commit_sha: sha("c") }),
    ],
    pypiVersions: new Set(["0.33.0.dev2"]),
  };
  const d = run(state);
  assert.equal(d.step, "prepare");
  assert.equal(d.version, "0.33.0.dev3");
  assert.deepEqual(d.stale, [3]);
});

test("untagged merged PR with V <= highest tag is stale", () => {
  const d = run({ tags: [tag("0.33.0.dev0"), tag("0.33.0.dev2")], prs: [pr("0.33.0.dev1")] });
  assert.equal(d.version, "0.33.0.dev3");
  assert.deepEqual(d.stale, [10]);
});

test("abandoned label: writer -> not in flight; triage -> ignored with warning", () => {
  const labelled = { labels: ["release-tool:abandoned"] };
  const byWriter = run({ versionAtHead: "0.33.0.dev1", prs: [pr("0.33.0.dev1", { ...labelled, abandoned_by_writer: true })] });
  assert.equal(byWriter.step, "fast-path");
  const byTriage = run({ versionAtHead: "0.33.0.dev1", prs: [pr("0.33.0.dev1", { ...labelled, abandoned_by_writer: false })] });
  assert.equal(byTriage.step, "continue");
  assert.match(byTriage.warnings.join("\n"), /not added by someone with write/);
});

test("closed unmerged bump PR is ignored", () => {
  const d = run({ prs: [pr("0.33.0.dev1", { merged: false, merge_commit_sha: null })] });
  assert.equal(d.step, "prepare");
  assert.equal(d.pr, undefined);
});

test("bump PRs whose base is not the branch are ignored", () => {
  assert.equal(run({ prs: [openPr("0.33.0.dev1", { base_ref: "master" })] }).step, "prepare");
  assert.equal(run({ prs: [pr("0.33.0.dev1", { base_ref: "r0.32" })] }).step, "prepare");
  assert.equal(run({ prs: [openPr("0.33.0.dev1", { head_ref: "release-tool/master-bump-0.33.0.dev1" })] }).step, "prepare");
});

test("in-flight V contradicting inputs -> refused", () => {
  assert.throws(() => run({ prs: [openPr("0.33.0.dev1")] }, { channel: "stable" }), refusal(/in flight.*channel=stable/));
  const state = { tags: [tag("0.33.0")], releases: [rel("0.33.0")], prs: [openPr("0.33.1")], pypiVersions: new Set(["0.33.0"]) };
  assert.throws(() => run(state, { channel: "stable", kind: "major" }), refusal(/in flight.*kind=patch/));
  assert.equal(run(state, { channel: "stable", kind: "patch" }).step, "wait");
});

test("typed version rules", () => {
  const state = { tags: [tag("0.31.1"), tag("0.33.0")], releases: [rel("0.31.1"), rel("0.33.0")], pypiVersions: new Set(["0.33.0"]) };
  const patch = { kind: "patch", channel: "stable" };
  assert.throws(() => run(state, { ...patch, version: "0.31.1" }), refusal(/not on the 0.33 line/));
  assert.throws(() => run(state, { ...patch, version: "0.33.3" }), refusal(/cannot be skipped/));
  assert.equal(run(state, { ...patch, version: "0.33.1" }).step, "prepare");
  assert.throws(() => run({}, { version: "0.33.0.dev0", channel: "stable" }), refusal(/channel=stable/));
  const legacy = { tags: [tag("0.33.0.dev0"), tag("0.33.0.dev1")] };
  assert.throws(() => run(legacy, { version: "0.33.0.dev1" }), refusal(/not newer/));
});

test("downgrade at resolution: major dev on r0.32 with v0.32.0 present", () => {
  const state = { branch: "r0.32", tags: [tag("0.32.0")], releases: [rel("0.32.0")], pypiVersions: new Set(["0.32.0"]) };
  assert.throws(() => run(state), refusal(/not newer than v0.32.0/));
});

test("PyPI missing: warning first, prepare of V+1 refused", () => {
  const missing = { pypiVersions: new Set(["0.32.0"]) };
  assert.throws(() => run(missing), refusal(/v0.33.0.dev0 is released on GitHub but not on PyPI.*Refusing/));
  const d = run(missing, { version: "0.33.0.dev0" });
  assert.equal(d.step, "already-released");
  assert.match(d.warnings[0], /^v0.33.0.dev0 is released on GitHub but not on PyPI; run with version=0.33.0.dev0/);
  assert.throws(() => run({ pypiVersions: null }), refusal(/Could not check PyPI/));
  assert.deepEqual(run().warnings, []);
});

test("prepare with branch absent", () => {
  const absent = { branchExists: false, headSha: null, versionAtHead: null, tags: [], releases: [], pypiVersions: new Set() };
  const d = run(absent, { commit_sha: sha("c") });
  assert.equal(d.step, "prepare");
  assert.equal(d.version, "0.33.0.dev0");
  assert.throws(() => run(absent), refusal(/40-character/));
  assert.throws(() => run(absent, { commit_sha: "abc1234" }), refusal(/40-character/));
  assert.throws(() => run(absent, { commit_sha: sha("c"), cherry_picks: "#1" }), refusal(/not allowed when cutting/));
  const patchAbsent = { ...absent, tags: [tag("0.33.0")], releases: [rel("0.33.0")], pypiVersions: new Set(["0.33.0"]) };
  assert.throws(() => run(patchAbsent, { kind: "patch", channel: "stable" }), refusal(/patch needs an existing branch/));
  // F10: after the branch is cut at 0.33.0.dev0, the next run is fast-path.
  assert.equal(run({ ...absent, branchExists: true, versionAtHead: "0.33.0.dev0" }).step, "fast-path");
});

test("commit_sha with an existing branch -> refused", () => {
  const state = { prs: [] };
  assert.throws(() => run(state, { commit_sha: sha("c") }), refusal(/already exists; commit_sha/));
});

test("checkCommitShaVersion", () => {
  checkCommitShaVersion("0.33.0.dev0", { x: 0, y: 33 });
  assert.throws(() => checkCommitShaVersion("0.34.0.dev0", { x: 0, y: 33 }), refusal(/not on the\s+0.33 line/));
  assert.throws(() => checkCommitShaVersion("garbage", { x: 0, y: 33 }), refusal(/garbage/));
});

test("tag vV elsewhere without release while V is in flight -> refused", () => {
  const state = { prs: [openPr("0.33.0.dev1")], tags: [tag("0.33.0.dev0"), tag("0.33.0.dev1", sha("b"))] };
  assert.throws(() => run(state), refusal(/not at the merge commit/));
});

test("duplicate drafts and unreadable drafts on the line -> refused", () => {
  const dup = { releases: [rel("0.33.0.dev0"), draft("0.33.0.dev1", { id: 2 }), draft("0.33.0.dev1", { id: 3 })] };
  assert.throws(() => run(dup), refusal(/2 drafts/));
  assert.throws(() => run({ releases: [draft("0.33.0rc1")] }), refusal(/not a version/));
  assert.equal(run({ releases: [rel("0.33.0.dev0"), draft("0.32.0.dev1")] }).step, "prepare");
});

test("unknown kind or channel -> refused", () => {
  assert.throws(() => run({}, { kind: "minor" }), refusal(/Unknown kind/));
  assert.throws(() => run({}, { channel: "rc" }), refusal(/Unknown channel/));
});

test("helpers", () => {
  assert.equal(bumpVersion("release-tool/bump-0.33.1"), "0.33.1");
  assert.equal(bumpVersion("release-tool/bump-x"), null);
  assert.equal(bumpVersion("release-tool/master-bump-0.34.0.dev0"), null);
  assert.equal(draftMapsToLine("v0.33.1", { x: 0, y: 33 }, "v"), true);
  assert.equal(draftMapsToLine("v0.33rc1", { x: 0, y: 33 }, "v"), true);
  assert.equal(draftMapsToLine("v0.331.0", { x: 0, y: 33 }, "v"), false);
  assert.equal(draftMapsToLine("0.33.1", { x: 0, y: 33 }, "v"), false);
});
