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
const { hasWrite, continueGuards, draftAnchorFailures, resolvePublishActor } = require("./guards");
const { loadConfig } = require("./config");
const { refusalMatching: refusal } = require("./errors");

const CONFIG = loadConfig("keras-hub");
const { BOT } = require("../test_support");
const MERGE = "a".repeat(40);
const OTHER = "b".repeat(40);

test("hasWrite reads the .permission field", () => {
  assert.equal(hasWrite("admin"), true);
  assert.equal(hasWrite("write"), true);
  for (const p of ["read", "triage", "maintain", "none", "", undefined]) assert.equal(hasWrite(p), false, String(p));
});

function guardArgs() {
  return {
    pr: {
      number: 12, state: "closed", merged: true, merge_commit_sha: MERGE,
      head_ref: "release-tool/bump-0.33.1", head_repo_full_name: "keras-team/keras-hub",
      base_repo_full_name: "keras-team/keras-hub", base_ref: "r0.33", author_login: BOT,
      merged_by_login: "alice", labels: [],
    },
    config: CONFIG, branch: "r0.33", version: "0.33.1", botLogin: BOT,
    mergedByPermission: "write", versionAtMergeSha: "0.33.1", tagShaForVersion: null,
    highestTagOnLine: "0.33.0", commitsAfterMerge: [],
  };
}

test("continue guards pass on a clean merged bot PR", () => {
  assert.deepEqual(continueGuards(guardArgs()), []);
  assert.deepEqual(continueGuards({ ...guardArgs(), tagShaForVersion: MERGE, highestTagOnLine: "0.33.1" }), []);
  assert.deepEqual(continueGuards({ ...guardArgs(), versionAtMergeSha: ["0.33.1", "0.33.1"] }), []);
  assert.deepEqual(continueGuards({ ...guardArgs(), highestTagOnLine: null }), []);
});

// Each entry flips exactly one guard and must produce exactly one failure, so
// deleting any single guard turns its case red.
const FLIPS = {
  "disabled config": (a) => { a.config = { ...CONFIG, enabled: false }; },
  "not merged": (a) => { a.pr.merged = false; },
  "base not a release branch": (a) => { a.pr.base_ref = "master"; a.branch = "master"; },
  "base is another release branch": (a) => { a.pr.base_ref = "r0.32"; },
  "head repo is a fork": (a) => { a.pr.head_repo_full_name = "mallory/keras-hub"; },
  "head ref wrong": (a) => { a.pr.head_ref = "release-tool/bump-0.33.2"; },
  "author is a human": (a) => { a.pr.author_login = "alice"; },
  "merged by the bot": (a) => { a.pr.merged_by_login = BOT; },
  "merged by nobody": (a) => { a.pr.merged_by_login = null; },
  "merger has only read": (a) => { a.mergedByPermission = "read"; },
  "merger is triage": (a) => { a.mergedByPermission = "triage"; },
  "version file mismatch": (a) => { a.versionAtMergeSha = "0.33.0"; },
  "one of two version files mismatches": (a) => { a.versionAtMergeSha = ["0.33.1", "0.33.0"]; },
  "tag elsewhere": (a) => { a.tagShaForVersion = OTHER; },
  "downgrade": (a) => { a.highestTagOnLine = "0.33.2"; },
  "equal without tag at merge sha": (a) => { a.highestTagOnLine = "0.33.1"; },
  "commits after merge": (a) => { a.commitsAfterMerge = [{ sha: "c".repeat(40), message: "Fix x\n\nbody" }]; },
};

test("continue guards: every guard flipped individually is rejected", () => {
  for (const [name, flip] of Object.entries(FLIPS)) {
    const a = guardArgs();
    flip(a);
    assert.equal(continueGuards(a).length, 1, name);
  }
  assert.ok(continueGuards({ ...guardArgs(), config: null }).length >= 1);
  assert.ok(continueGuards({ ...guardArgs(), botLogin: "" }).some((m) => /bot login is empty/.test(m)));
});

test("head repo check falls back to targetRepo when the PR lacks base_repo_full_name", () => {
  const a = guardArgs();
  delete a.pr.base_repo_full_name;
  assert.equal(continueGuards(a).length, 1);
  assert.deepEqual(continueGuards({ ...a, targetRepo: "keras-team/keras-hub" }), []);
  assert.equal(continueGuards({ ...a, targetRepo: "laxmareddyp/keras-hub" }).length, 1);
});

test("post-merge commits are listed with the abandon instruction", () => {
  const a = guardArgs();
  a.commitsAfterMerge = [{ sha: "c".repeat(40), message: "Fix x\n\nbody" }, "d".repeat(40)];
  const [msg] = continueGuards(a);
  assert.match(msg, /these 2 commits would be left out of v0.33.1: ccccccc Fix x; ddddddd; label PR #12 `release-tool:abandoned`/);
});

test("no PR at all fails", () => {
  assert.deepEqual(continueGuards({ ...guardArgs(), pr: null }), ["there is no bump PR"]);
});

function anchorArgs() {
  return {
    draft: { tag_name: "v0.33.1", draft: true, target_commitish: MERGE, author_login: BOT, body: "notes" },
    version: "0.33.1", botLogin: BOT, tagExists: false, anchorSha: MERGE, versionAtTarget: "0.33.1",
  };
}

test("draft anchor: bot draft at the anchor sha with edited notes -> passes", () => {
  const a = anchorArgs();
  a.draft.body = "Edited by a human.";
  a.draft.name = "Renamed";
  assert.deepEqual(draftAnchorFailures(a), []);
});

test("draft anchor: each tampering is refused", () => {
  const cases = {
    "human-authored draft": (a) => { a.draft.author_login = "alice"; },
    "retargeted to another sha": (a) => { a.draft.target_commitish = OTHER; },
    "retargeted to a branch name": (a) => { a.draft.target_commitish = "r0.33"; },
    "short sha target": (a) => { a.draft.target_commitish = MERGE.slice(0, 7); },
    "tag edited": (a) => { a.draft.tag_name = "v0.33.2"; },
    "tag already exists": (a) => { a.tagExists = true; },
    "no anchor found": (a) => { a.anchorSha = null; },
    "not a draft": (a) => { a.draft.draft = false; },
    "version at target differs": (a) => { a.versionAtTarget = "0.33.0"; },
    "empty bot login": (a) => { a.botLogin = ""; },
  };
  for (const [name, tamper] of Object.entries(cases)) {
    const a = anchorArgs();
    tamper(a);
    assert.equal(draftAnchorFailures(a).length, 1, name);
  }
  assert.deepEqual(draftAnchorFailures({ ...anchorArgs(), draft: null }), ["there is no draft"]);
});

test("actor: human with a fake requested_by is evaluated as the human", () => {
  assert.equal(resolvePublishActor({ triggeringActor: "alice", requestedBy: "bob", appSlug: "keras-release" }), "alice");
  assert.equal(resolvePublishActor({ triggeringActor: "alice", requestedBy: "", appSlug: "keras-release" }), "alice");
});

test("actor: the App bot is evaluated as requested_by", () => {
  assert.equal(resolvePublishActor({ triggeringActor: "keras-release[bot]", requestedBy: "bob", appSlug: "keras-release" }), "bob");
  assert.throws(() => resolvePublishActor({ triggeringActor: "keras-release[bot]", requestedBy: "", appSlug: "keras-release" }), refusal(/invalid requested_by/));
  assert.throws(() => resolvePublishActor({ triggeringActor: "keras-release[bot]", requestedBy: "other[bot]", appSlug: "keras-release" }), refusal(/invalid requested_by/));
});

test("actor: github-actions[bot] and other bots are rejected", () => {
  for (const actor of ["github-actions[bot]", "dependabot[bot]", "other-app[BOT]"]) {
    assert.throws(() => resolvePublishActor({ triggeringActor: actor, requestedBy: "bob", appSlug: "keras-release" }), refusal(/may not run publish.yml/), actor);
  }
});

test("actor: empty slug or actor is rejected", () => {
  assert.throws(() => resolvePublishActor({ triggeringActor: "alice", requestedBy: "", appSlug: "" }), refusal(/RELEASE_APP_SLUG is empty/));
  assert.throws(() => resolvePublishActor({ triggeringActor: "[bot]", requestedBy: "bob", appSlug: "" }), refusal(/RELEASE_APP_SLUG is empty/));
  assert.throws(() => resolvePublishActor({ triggeringActor: "", requestedBy: "bob", appSlug: "keras-release" }), refusal(/actor is empty/));
});
