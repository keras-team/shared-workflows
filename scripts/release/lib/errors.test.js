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
const { RefusalError, formatRefusal, refusalMatching, DEFAULT_NEXT } = require("./errors");

test("refusalMatching matches only RefusalErrors with a matching message", () => {
  assert.equal(refusalMatching(/No/)(new RefusalError("No.")), true);
  assert.equal(refusalMatching(/Yes/)(new RefusalError("No.")), false);
  assert.equal(refusalMatching(/No/)(new Error("No.")), false);
});

test("RefusalError carries message and next", () => {
  const e = new RefusalError("No.", "do this.");
  assert.ok(e instanceof Error);
  assert.equal(e.name, "RefusalError");
  assert.equal(e.message, "No.");
  assert.equal(e.next, "do this.");
});

test("RefusalError defaults next", () => {
  assert.equal(new RefusalError("No.").next, DEFAULT_NEXT);
  assert.equal(new RefusalError("No.", "  ").next, DEFAULT_NEXT);
});

test("formatRefusal ends with the Next: line", () => {
  const text = formatRefusal(new RefusalError("No.", "do this."));
  assert.equal(text, "No.\n\nNext: do this.");
  assert.match(text.split("\n").pop(), /^Next: /);
});

test("formatRefusal marks other errors as unexpected, still with Next:", () => {
  const text = formatRefusal(new TypeError("boom"));
  assert.match(text, /^Unexpected error: boom/);
  assert.match(text.split("\n").pop(), /^Next: /);
  assert.match(formatRefusal("raw"), /^Unexpected error: raw/);
});
