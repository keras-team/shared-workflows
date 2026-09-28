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
 * The PEP 440 subset the release tool accepts: X.Y.Z and X.Y.Z.devN, in
 * normalized form only. Leading zeros are rejected so that every version has
 * exactly one spelling, and therefore exactly one tag name.
 */

const NUM = "(0|[1-9]\\d*)";
const VERSION_RE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:\\.dev${NUM})?$`);

function tryParse(v) {
  if (typeof v !== "string") return null;
  const m = VERSION_RE.exec(v);
  if (!m) return null;
  return {
    x: Number(m[1]),
    y: Number(m[2]),
    z: Number(m[3]),
    dev: m[4] === undefined ? null : Number(m[4]),
  };
}

function parse(v) {
  const parsed = tryParse(v);
  if (!parsed) {
    throw new Error(
      `"${v}" is not a supported version (expected X.Y.Z or X.Y.Z.devN).`,
    );
  }
  return parsed;
}

function isValid(v) {
  return tryParse(v) !== null;
}

function cmpNum(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** -1 | 0 | 1. A dev release sorts before its final release. */
function compare(a, b) {
  const pa = typeof a === "string" ? parse(a) : a;
  const pb = typeof b === "string" ? parse(b) : b;
  for (const key of ["x", "y", "z"]) {
    const c = cmpNum(pa[key], pb[key]);
    if (c !== 0) return c;
  }
  if (pa.dev === pb.dev) return 0;
  if (pa.dev === null) return 1;
  if (pb.dev === null) return -1;
  return cmpNum(pa.dev, pb.dev);
}

function isDev(v) {
  return parse(v).dev !== null;
}

function format({ x, y, z, dev }) {
  const base = `${x}.${y}.${z}`;
  return dev === null || dev === undefined ? base : `${base}.dev${dev}`;
}

module.exports = { parse, tryParse, isValid, compare, isDev, format };
