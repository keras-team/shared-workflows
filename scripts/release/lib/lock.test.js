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
const lock = require("./lock");

const PATTERN = "^r(\\d+)\\.(\\d+)$";
const LOCK = { selfRunId: 100, repository: "keras-hub", branch: "r0.33", pattern: PATTERN, prefix: "v" };
const relRun = (display_title, over = {}) => ({ id: 1, workflow: "release.yml", display_title, status: "in_progress", ...over });
const pubRun = (display_title, over = {}) => ({ id: 2, workflow: "publish.yml", display_title, status: "queued", ...over });
const conflicts = (runs, over = {}) => lock.runConflicts({ runs, ...LOCK, ...over });

test("ACTIVE_STATUSES is exactly the plan's list", () => {
  assert.deepEqual([...lock.ACTIVE_STATUSES].sort(), ["in_progress", "pending", "queued", "requested", "waiting"]);
});

test("parseReleaseTitle", () => {
  assert.deepEqual(lock.parseReleaseTitle("release keras-hub r0.33 patch auto"),
    { repository: "keras-hub", branch: "r0.33", kind: "patch", version: "auto" });
  assert.deepEqual(lock.parseReleaseTitle("release keras r0.33 major 0.33.1"),
    { repository: "keras", branch: "r0.33", kind: "major", version: "0.33.1" });
  for (const bad of [
    "release keras-hub r0.33 patch", "release keras-hub r0.33 patch auto x", "publish keras-hub r0.33 patch auto",
    "release keras-hub r0.33 minor auto", "release  keras-hub r0.33 patch auto", "release Keras r0.33 patch auto", "", null,
  ]) {
    assert.equal(lock.parseReleaseTitle(bad), null, String(bad));
  }
});

test("parsePublishTitle", () => {
  assert.deepEqual(lock.parsePublishTitle("publish keras-hub v0.33.1"), { repository: "keras-hub", tag: "v0.33.1" });
  for (const bad of ["publish keras-hub", "publish keras-hub v0.33.1 x", "release keras-hub v0.33.1", "Publish keras v1.0.0"]) {
    assert.equal(lock.parsePublishTitle(bad), null, bad);
  }
});

test("release runs: same repo+branch conflicts; 'auto' and '0.33.1' lock each other", () => {
  assert.equal(conflicts([relRun("release keras-hub r0.33 patch auto")]).length, 1);
  assert.equal(conflicts([relRun("release keras-hub r0.33 patch 0.33.1")]).length, 1);
  assert.equal(conflicts([relRun("release keras-hub r0.33 major auto")]).length, 1);
  assert.equal(conflicts([relRun("release keras-hub r0.32 patch auto")]).length, 0);
});

test("lock title parsing: keras does not match a keras-hub run and vice versa", () => {
  assert.equal(conflicts([relRun("release keras-hub r0.33 patch auto")], { repository: "keras" }).length, 0);
  assert.equal(conflicts([relRun("release keras r0.33 patch auto")]).length, 0);
  assert.equal(conflicts([pubRun("publish keras-hub v0.33.1")], { repository: "keras" }).length, 0);
  assert.equal(conflicts([pubRun("publish keras v0.33.1")]).length, 0);
});

test("publish run on the same line locks; on another line does not", () => {
  assert.equal(conflicts([pubRun("publish keras-hub v0.33.1")]).length, 1);
  assert.equal(conflicts([pubRun("publish keras-hub v0.33.0.dev2")]).length, 1);
  assert.equal(conflicts([pubRun("publish keras-hub v0.33.1")], { branch: "r0.32" }).length, 0);
  assert.equal(conflicts([pubRun("publish keras-hub v0.330.1")]).length, 0);
});

test("unparseable titles of active runs are conflicts (fail closed)", () => {
  assert.equal(conflicts([relRun("release keras-hub r0 33 patch auto")]).length, 1);
  assert.equal(conflicts([relRun("Release")]).length, 1);
  assert.equal(conflicts([pubRun("publish")]).length, 1);
  assert.equal(conflicts([pubRun("publish keras-hub latest")]).length, 1);
  assert.equal(conflicts([pubRun("publish keras-hub vnext")]).length, 1);
  assert.equal(conflicts([{ id: 3, workflow: "other.yml", display_title: "x", status: "queued" }]).length, 1);
});

test("inactive runs and our own run are ignored", () => {
  for (const status of ["completed", "cancelled", "action_required", undefined]) {
    assert.equal(conflicts([relRun("release keras-hub r0.33 patch auto", { status })]).length, 0, String(status));
  }
  assert.equal(conflicts([relRun("release keras-hub r0.33 patch auto", { id: 100 })]).length, 0);
  assert.equal(conflicts([relRun("release keras-hub r0.33 patch auto", { id: "100" })]).length, 0);
  for (const status of ["requested", "queued", "pending", "waiting", "in_progress"]) {
    assert.equal(conflicts([relRun("release keras-hub r0.33 patch auto", { status })]).length, 1, status);
  }
});

// PR and draft signals.
const state = (prs = [], releases = []) => ({ branch: "r0.33", prs, releases });
const open = (v, over = {}) => ({ number: 7, state: "open", merged: false, head_ref: `release-tool/bump-${v}`, base_ref: "r0.33", ...over });
const draft = (tag) => ({ tag_name: tag, draft: true });
const prDraft = (s, step, version) => lock.prDraftConflicts({ state: s, step, version, prefix: "v", pattern: PATTERN });

test("PR signal: open bump PR into the branch refuses every step except wait for bump-V", () => {
  const s = state([open("0.33.1")]);
  assert.deepEqual(prDraft(s, "wait", "0.33.1"), []);
  for (const step of ["prepare", "continue", "resume-continue", "fast-path", "publish", "already-released"]) {
    assert.equal(prDraft(s, step, "0.33.1").length, 1, step);
  }
  assert.equal(prDraft(s, "wait", "0.33.2").length, 1);
});

test("PR signal ignores closed PRs, other bases and non-bump heads", () => {
  assert.deepEqual(prDraft(state([open("0.33.1", { state: "closed" })]), "prepare", "0.33.2"), []);
  assert.deepEqual(prDraft(state([open("0.33.1", { base_ref: "master" })]), "prepare", "0.33.2"), []);
  assert.deepEqual(prDraft(state([open("0.34.0.dev0", { head_ref: "release-tool/master-bump-0.34.0.dev0", base_ref: "master" })]), "prepare", "0.33.2"), []);
  assert.deepEqual(prDraft(state([open("x", { head_ref: "feature/foo" })]), "prepare", "0.33.2"), []);
  assert.equal(prDraft(state([open("x", { head_ref: "release-tool/bump-garbage" })]), "prepare", "0.33.2").length, 1);
});

test("draft signal: drafts on the line refuse every step except publish for vV", () => {
  const s = state([], [draft("v0.33.1")]);
  assert.deepEqual(prDraft(s, "publish", "0.33.1"), []);
  for (const step of ["prepare", "continue", "resume-continue", "fast-path", "wait", "already-released"]) {
    assert.equal(prDraft(s, step, "0.33.1").length, 1, step);
  }
  assert.equal(prDraft(s, "publish", "0.33.2").length, 1);
});

test("draft signal ignores published releases and other lines; odd drafts fail closed", () => {
  assert.deepEqual(prDraft(state([], [{ tag_name: "v0.33.1", draft: false }]), "prepare", "0.33.2"), []);
  assert.deepEqual(prDraft(state([], [draft("v0.32.1")]), "prepare", "0.33.2"), []);
  assert.equal(prDraft(state([], [draft("v0.33.1rc1")]), "prepare", "0.33.2").length, 1);
});

test("exemptions are exact: wait does not exempt a draft, publish does not exempt a PR", () => {
  const s = state([open("0.33.1")], [draft("v0.33.1")]);
  assert.deepEqual(prDraft(s, "wait", "0.33.1").map((c) => c.type), ["draft"]);
  assert.deepEqual(prDraft(s, "publish", "0.33.1").map((c) => c.type), ["pr"]);
});
