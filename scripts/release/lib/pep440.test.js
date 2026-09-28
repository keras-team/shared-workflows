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
const pep440 = require("./pep440");

test("parse accepts X.Y.Z and X.Y.Z.devN", () => {
  assert.deepEqual(pep440.parse("0.33.1"), { x: 0, y: 33, z: 1, dev: null });
  assert.deepEqual(pep440.parse("0.33.0.dev2"), { x: 0, y: 33, z: 0, dev: 2 });
  assert.deepEqual(pep440.parse("10.0.0.dev0"), { x: 10, y: 0, z: 0, dev: 0 });
});

test("parse rejects everything else", () => {
  for (const bad of [
    "", "0.33", "v0.33.0", "0.33.0rc1", "0.33.0.post1", "0.33.0-dev1",
    "0.33.0.dev", "01.2.3", "0.033.0", "0.33.0.dev01", " 0.33.0", "0.33.0\n", "1.2.3.4",
  ]) {
    assert.throws(() => pep440.parse(bad), /not a supported version/, bad);
    assert.equal(pep440.tryParse(bad), null, bad);
    assert.equal(pep440.isValid(bad), false, bad);
  }
  assert.equal(pep440.tryParse(undefined), null);
});

test("compare orders dev before final and numerically", () => {
  const sorted = [
    "0.9.0", "0.10.0.dev0", "0.10.0.dev1", "0.10.0.dev10", "0.10.0", "0.10.1", "1.0.0",
  ];
  const shuffled = [...sorted].reverse();
  assert.deepEqual(shuffled.sort(pep440.compare), sorted);
  assert.equal(pep440.compare("0.33.0", "0.33.0"), 0);
  assert.equal(pep440.compare("0.33.0.dev1", "0.33.0"), -1);
  assert.equal(pep440.compare("0.33.0", "0.33.0.dev1"), 1);
  assert.equal(pep440.compare("0.33.0.dev2", "0.33.0.dev10"), -1);
});

test("isDev and format round trip", () => {
  assert.equal(pep440.isDev("0.33.0.dev0"), true);
  assert.equal(pep440.isDev("0.33.0"), false);
  for (const v of ["0.33.0", "0.33.0.dev0", "3.16.12"]) {
    assert.equal(pep440.format(pep440.parse(v)), v);
  }
});
