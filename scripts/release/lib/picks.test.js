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
const P = require("./picks");
const { refusalMatching: refusal } = require("./errors");

// Default-branch first-parent chain, newest first (git rev-list order).
const CHAIN = ["e".repeat(40), "d".repeat(40), "c1" + "0".repeat(38), "c2" + "0".repeat(38), "b".repeat(40), "a".repeat(40)];

test("parsePicks: PR numbers and sha prefixes, commas or whitespace", () => {
  assert.deepEqual(P.parsePicks("#3101, #3110 abc1234\n\tDEF5678ab"), [
    { type: "pr", number: 3101 }, { type: "pr", number: 3110 },
    { type: "sha", sha: "abc1234" }, { type: "sha", sha: "def5678ab" },
  ]);
  assert.deepEqual(P.parsePicks("#1,#1, abc1234 ABC1234"), [{ type: "pr", number: 1 }, { type: "sha", sha: "abc1234" }]);
});

test("parsePicks: empty means zero picks", () => {
  for (const empty of ["", "   ", " , ,", undefined, null]) assert.deepEqual(P.parsePicks(empty), []);
});

test("parsePicks: unknown tokens are refused", () => {
  for (const bad of ["3101", "#", "#0", "#12a", "abc123", "xyz1234", "https://github.com/x/pull/1", "#-1", "a".repeat(41)]) {
    assert.throws(() => P.parsePicks(bad), refusal(/neither a PR number/), bad);
  }
});

test("validatePrForPick: not merged or not on the default branch -> refused", () => {
  P.validatePrForPick({ number: 1, merged: true, merge_commit_sha: CHAIN[0], base_ref: "master" }, "master");
  assert.throws(() => P.validatePrForPick({ number: 1, merged: false, merge_commit_sha: null, base_ref: "master" }, "master"), refusal(/not merged/));
  assert.throws(() => P.validatePrForPick({ number: 1, merged: true, merge_commit_sha: CHAIN[0], base_ref: "r0.33" }, "master"), refusal(/merged into r0.33, not master/));
  assert.throws(() => P.validatePrForPick(null, "master"), refusal(/not merged/));
});

test("classifyMerge: merge, squash, rebase", () => {
  assert.equal(P.classifyMerge({ parents: 2, commits: 5, parentMapsToSamePr: false }), "merge");
  assert.equal(P.classifyMerge({ parents: ["x", "y"], commits: 1, parentMapsToSamePr: false }), "merge");
  assert.equal(P.classifyMerge({ parents: 1, commits: 1, parentMapsToSamePr: false }), "squash");
  assert.equal(P.classifyMerge({ parents: 1, commits: 1, parentMapsToSamePr: true }), "squash");
  assert.equal(P.classifyMerge({ parents: 1, commits: 4, parentMapsToSamePr: false }), "squash");
  assert.equal(P.classifyMerge({ parents: 1, commits: 4, parentMapsToSamePr: true }), "rebase");
  assert.throws(() => P.classifyMerge({ parents: 3, commits: 1 }), refusal(/3 parents/));
});

test("orderPicks: sorts oldest first and expands prefixes", () => {
  const picks = [
    { type: "sha", sha: "eeeeeee" },
    { type: "pr", number: 7, sha: "a".repeat(40) },
    { type: "sha", sha: "DDDDDDD" },
  ];
  assert.deepEqual(P.orderPicks(picks, CHAIN), [
    { type: "pr", number: 7, sha: "a".repeat(40) },
    { type: "sha", sha: "d".repeat(40) },
    { type: "sha", sha: "e".repeat(40) },
  ]);
});

test("orderPicks: off-first-parent, ambiguous and duplicate commits are refused", () => {
  assert.throws(() => P.orderPicks([{ type: "sha", sha: "f".repeat(7) }], CHAIN), refusal(/not on the default branch's first-parent/));
  assert.throws(() => P.orderPicks([{ type: "pr", number: 9, sha: "9".repeat(40) }], CHAIN), refusal(/PR #9.*first-parent/));
  assert.throws(() => P.orderPicks([{ type: "sha", sha: "c" }], CHAIN), refusal(/ambiguous/));
  assert.throws(
    () => P.orderPicks([{ type: "pr", number: 7, sha: "a".repeat(40) }, { type: "sha", sha: "aaaaaaa" }], CHAIN),
    refusal(/#7 and aaaaaaa are the same commit/),
  );
  assert.throws(() => P.orderPicks([{ type: "pr", number: 7 }], CHAIN), /has no sha/);
});

test("cherryPickArgs: always -x; -m 1 for merge commits; rebase rejected", () => {
  assert.deepEqual(P.cherryPickArgs({ type: "pr", number: 1, sha: CHAIN[0], method: "squash" }), ["cherry-pick", "-x", CHAIN[0]]);
  assert.deepEqual(P.cherryPickArgs({ type: "pr", number: 1, sha: CHAIN[0], method: "merge" }), ["cherry-pick", "-x", "-m", "1", CHAIN[0]]);
  assert.throws(() => P.cherryPickArgs({ type: "pr", number: 1, sha: CHAIN[0], method: "rebase" }), refusal(/rebase-merged/));
  assert.throws(() => P.cherryPickArgs({ type: "sha", sha: CHAIN[0] }), /unknown method/);
  assert.throws(() => P.cherryPickArgs({ type: "sha" }), /no sha/);
});

test("Cherry-picks line round trip", () => {
  const picks = [
    { type: "pr", number: 3101, sha: "abc1234" + "0".repeat(33) },
    { type: "pr", number: 3110, sha: "def5678" + "0".repeat(33) },
    { type: "sha", sha: "1234567" + "0".repeat(33) },
  ];
  const line = P.cherryPicksLine(picks);
  assert.equal(line, "Cherry-picks: #3101 (abc1234), #3110 (def5678), 1234567");
  const body = `Bump to 0.33.1.\n\n${line}\n\nOther text #999 is not a pick.`;
  assert.deepEqual([...P.parseCherryPicksLines([body])].sort(), [3101, 3110]);
  assert.equal(P.cherryPicksLine([]), "");
});

test("parseCherryPicksLines: several bodies, CRLF, human-written lines, junk", () => {
  const bodies = [
    "Cherry-picks: #1 (aaaaaaa)\r\nmore",
    "  cherry-picks: #2, #3",
    "Squash-merged hand pick.\n\nCherry-picks: #4",
    "No line here #5",
    null,
    "Cherry-picks:",
  ];
  assert.deepEqual([...P.parseCherryPicksLines(bodies)].sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.deepEqual([...P.parseCherryPicksLines([])], []);
});
