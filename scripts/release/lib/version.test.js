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
const V = require("./version");
const { RefusalError, refusalMatching: refusal } = require("./errors");
const { loadConfig } = require("./config");

const PATTERN = loadConfig("keras-hub").release_branch_pattern;

test("branchXY reads X and Y from the pattern", () => {
  assert.deepEqual(V.branchXY("r0.33", PATTERN), { x: 0, y: 33 });
  for (const bad of ["master", "r0.33.1", "xr0.33", "r0.x", "", undefined]) {
    assert.throws(() => V.branchXY(bad, PATTERN), refusal(/not a release branch/), String(bad));
  }
});

test("lineVersions keeps only the X.Y line, prefix stripped, sorted", () => {
  const tags = [
    { name: "v0.33.0" }, { name: "v0.32.0" }, "v0.33.0.dev1", { name: "v0.33.1" },
    { name: "0.33.2" }, { name: "v0.33.0rc1" }, { name: "keras-v0.33.3" },
  ];
  assert.deepEqual(V.lineVersions(tags, { x: 0, y: 33 }, "v"), ["0.33.0.dev1", "0.33.0", "0.33.1"]);
});

test("highest and highestStable", () => {
  assert.equal(V.highest(["0.33.0.dev1", "0.33.0", "0.32.9"]), "0.33.0");
  assert.equal(V.highest(["0.34.0.dev0", "0.33.0"]), "0.34.0.dev0");
  assert.equal(V.highestStable(["0.34.0.dev0", "0.33.0"]), "0.33.0");
  assert.equal(V.highest([]), null);
  assert.equal(V.highestStable(["0.34.0.dev0"]), null);
});

// keras-hub history fixtures (plan section 7, version resolution).
test("r0.32 {v0.32.0.dev0}: major dev -> 0.32.0.dev1, major stable -> 0.32.0", () => {
  const args = { xy: { x: 0, y: 32 }, lineVersions: ["0.32.0.dev0"] };
  assert.equal(V.computeVersion({ ...args, kind: "major", channel: "dev" }), "0.32.0.dev1");
  assert.equal(V.computeVersion({ ...args, kind: "major", channel: "stable" }), "0.32.0");
});

test("r0.31 {v0.31.0, v0.31.1}: patch stable -> 0.31.2, patch dev -> 0.31.2.dev0", () => {
  const args = { xy: { x: 0, y: 31 }, lineVersions: ["0.31.0", "0.31.1"] };
  assert.equal(V.computeVersion({ ...args, kind: "patch", channel: "stable" }), "0.31.2");
  assert.equal(V.computeVersion({ ...args, kind: "patch", channel: "dev" }), "0.31.2.dev0");
  assert.equal(
    V.computeVersion({ ...args, lineVersions: [...args.lineVersions, "0.31.2.dev0"], kind: "patch", channel: "dev" }),
    "0.31.2.dev1",
  );
});

test("major with no tags -> X.Y.0 / X.Y.0.dev0", () => {
  const args = { xy: { x: 0, y: 34 }, lineVersions: [] };
  assert.equal(V.computeVersion({ ...args, kind: "major", channel: "stable" }), "0.34.0");
  assert.equal(V.computeVersion({ ...args, kind: "major", channel: "dev" }), "0.34.0.dev0");
});

test("patch with no stable X.Y.0 -> refused, use kind=major", () => {
  for (const lineVersions of [[], ["0.33.0.dev0", "0.33.0.dev1"]]) {
    assert.throws(
      () => V.computeVersion({ kind: "patch", channel: "stable", xy: { x: 0, y: 33 }, lineVersions }),
      (e) => e instanceof RefusalError && /kind=major/.test(e.next),
    );
  }
});

test("computeVersion rejects unknown kind/channel", () => {
  const xy = { x: 0, y: 33 };
  assert.throws(() => V.computeVersion({ kind: "minor", channel: "dev", xy, lineVersions: [] }), refusal(/Unknown kind/));
  assert.throws(() => V.computeVersion({ kind: "major", channel: "rc", xy, lineVersions: [] }), refusal(/Unknown channel/));
});

test("checkConsistent: X.Y, channel and kind", () => {
  const ok = { kind: "patch", channel: "stable", xy: { x: 0, y: 33 } };
  V.checkConsistent("0.33.1", ok);
  V.checkConsistent("0.33.0.dev2", { kind: "major", channel: "dev", xy: { x: 0, y: 33 } });
  assert.throws(() => V.checkConsistent("0.31.1", ok), refusal(/not on the 0.33 line/));
  assert.throws(() => V.checkConsistent("0.33.1.dev0", ok), refusal(/channel=stable/));
  assert.throws(() => V.checkConsistent("0.33.1", { ...ok, channel: "dev" }), refusal(/channel=dev/));
  assert.throws(() => V.checkConsistent("0.33.0", ok), refusal(/kind=major release/));
  assert.throws(() => V.checkConsistent("0.33.1", { ...ok, kind: "major" }), refusal(/kind=patch release/));
  assert.throws(() => V.checkConsistent("v0.33.1", ok), refusal(/not a supported version/));
});

test("previousReleaseTag", () => {
  const all = ["0.31.0", "0.31.0.dev0", "0.31.1", "0.32.0", "0.32.1", "0.33.0.dev1", "0.17.0", "0.17.1"];
  assert.equal(V.previousReleaseTag("0.33.0", all, "v"), "v0.32.0");
  assert.equal(V.previousReleaseTag("0.33.0.dev2", all, "v"), "v0.32.0");
  assert.equal(V.previousReleaseTag("0.31.1", ["0.31.0", "0.31.1.dev0", "0.31.0.dev0"], "v"), "v0.31.0");
  assert.equal(V.previousReleaseTag("0.31.2", all, "v"), "v0.31.1");
  assert.equal(V.previousReleaseTag("1.0.0", ["0.17.0", "0.17.1", "0.9.0", "1.0.0.dev0"], "v"), "v0.17.0");
  assert.equal(V.previousReleaseTag("0.1.0", ["0.1.0.dev0", "0.0.1"], "v"), null);
  assert.equal(V.previousReleaseTag("0.31.1", ["0.31.1.dev0", "0.30.0"], "v"), null);
});

test("releaseFlags", () => {
  const all = ["0.31.1", "0.32.0", "0.33.0", "0.34.0.dev0"];
  assert.deepEqual(V.releaseFlags("0.34.0.dev1", all), { prerelease: true, make_latest: "false" });
  assert.deepEqual(V.releaseFlags("0.31.2", all), { prerelease: false, make_latest: "false" });
  assert.deepEqual(V.releaseFlags("0.33.1", all), { prerelease: false, make_latest: "true" });
  assert.deepEqual(V.releaseFlags("0.33.0", all), { prerelease: false, make_latest: "true" });
  assert.deepEqual(V.releaseFlags("0.34.0", all), { prerelease: false, make_latest: "true" });
  assert.deepEqual(V.releaseFlags("0.1.0", []), { prerelease: false, make_latest: "true" });
});

test("readVersionFromFile: __version__ and version =", () => {
  const hub = 'from x import y\n\n# Unique source of truth.\n__version__ = "0.33.0.dev0"\n\n\ndef version():\n    return __version__\n';
  assert.equal(V.readVersionFromFile(hub), "0.33.0.dev0");
  const toml = '[project]\nname = "keras-kinetic"\nversion = "0.0.3"\ntarget-version = "py311"\n';
  assert.equal(V.readVersionFromFile(toml), "0.0.3");
  assert.equal(V.readVersionFromFile("__version__ = '1.2.3'  # pinned\r\n"), "1.2.3");
});

test("readVersionFromFile refuses zero or several version lines", () => {
  assert.throws(() => V.readVersionFromFile("x = 1\n"), refusal(/found 0/));
  assert.throws(() => V.readVersionFromFile('__version__ = "1"\nversion = "2"\n'), refusal(/found 2/));
  assert.throws(() => V.readVersionFromFile('    version = "1.0.0"\n'), refusal(/found 0/));
});

test("rewriteVersionInFile touches only the version line", () => {
  const hub = 'a = 1\n__version__ = "0.33.0.dev0"\nb = "version = 2"\n';
  assert.equal(V.rewriteVersionInFile(hub, "0.33.0.dev1"), 'a = 1\n__version__ = "0.33.0.dev1"\nb = "version = 2"\n');
  const toml = '[project]\nversion = "0.0.3"\ndependencies = []\n';
  assert.equal(V.rewriteVersionInFile(toml, "0.0.4"), '[project]\nversion = "0.0.4"\ndependencies = []\n');
  const crlf = "x\r\n__version__ = '1.2.3'  # keep\r\ny\r\n";
  assert.equal(V.rewriteVersionInFile(crlf, "1.2.4"), "x\r\n__version__ = '1.2.4'  # keep\r\ny\r\n");
  const noNewline = '__version__ = "1.2.3"';
  assert.equal(V.rewriteVersionInFile(noNewline, "1.2.4"), '__version__ = "1.2.4"');
});

test("rewriteVersionInFile refuses bad versions and ambiguous files", () => {
  assert.throws(() => V.rewriteVersionInFile('__version__ = "1.2.3"\n', "1.2"), /not a supported version/);
  assert.throws(() => V.rewriteVersionInFile('__version__ = "1"\n__version__ = "2"\n', "1.2.3"), refusal(/found 2/));
});
