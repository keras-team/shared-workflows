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
 * Version math: branch X.Y, computed next version, typed-version consistency,
 * previous-release tag, release flags, and version-file read/rewrite.
 */

const pep440 = require("./pep440");
const { RefusalError } = require("./errors");

function branchXY(branch, pattern) {
  const m = typeof branch === "string" ? new RegExp(pattern).exec(branch) : null;
  if (!m || !/^\d+$/.test(m[1] || "") || !/^\d+$/.test(m[2] || "")) {
    throw new RefusalError(
      `"${branch}" is not a release branch (must match ${pattern}).`,
      "set release_branch to a release branch name such as r0.33.",
    );
  }
  return { x: Number(m[1]), y: Number(m[2]) };
}

function tagName(t) {
  return typeof t === "string" ? t : t && t.name;
}

/** Versions (prefix stripped) of tags on the X.Y line, ascending. */
function lineVersions(tags, xy, prefix) {
  const out = [];
  for (const t of tags || []) {
    const name = tagName(t);
    if (typeof name !== "string" || !name.startsWith(prefix)) continue;
    const v = name.slice(prefix.length);
    const p = pep440.tryParse(v);
    if (p && p.x === xy.x && p.y === xy.y) out.push(v);
  }
  return out.sort(pep440.compare);
}

function highest(versions) {
  const valid = (versions || []).filter(pep440.isValid);
  if (!valid.length) return null;
  return valid.reduce((a, b) => (pep440.compare(a, b) >= 0 ? a : b));
}

function highestStable(versions) {
  return highest((versions || []).filter((v) => pep440.isValid(v) && !pep440.isDev(v)));
}

/** Throws on a kind or channel outside the panel's choices. */
function checkKindChannel(kind, channel) {
  if (kind !== "major" && kind !== "patch") {
    throw new RefusalError(`Unknown kind "${kind}".`, "choose kind major or patch.");
  }
  if (channel !== "dev" && channel !== "stable") {
    throw new RefusalError(`Unknown channel "${channel}".`, "choose channel dev or stable.");
  }
}

/** Plan section 4 "Version resolution", for a blank `version`. */
function computeVersion({ kind, channel, xy, lineVersions: versions }) {
  checkKindChannel(kind, channel);
  const parsed = (versions || []).map(pep440.tryParse).filter(Boolean);
  let z = 0;
  if (kind === "patch") {
    const stable = parsed.filter((p) => p.dev === null && p.x === xy.x && p.y === xy.y);
    if (!stable.some((p) => p.z === 0)) {
      throw new RefusalError(
        `There is no stable ${xy.x}.${xy.y}.0 tag yet, so there is nothing to patch.`,
        `use kind=major to release ${xy.x}.${xy.y}.0 (or a ${xy.x}.${xy.y}.0.devN).`,
      );
    }
    z = Math.max(...stable.map((p) => p.z)) + 1;
  }
  const target = { x: xy.x, y: xy.y, z, dev: null };
  if (channel === "stable") return pep440.format(target);
  const devs = parsed
    .filter((p) => p.x === target.x && p.y === target.y && p.z === target.z && p.dev !== null)
    .map((p) => p.dev);
  target.dev = devs.length ? Math.max(...devs) + 1 : 0;
  return pep440.format(target);
}

/** Throws when V does not belong to the branch line, channel or kind. */
function checkConsistent(v, { kind, channel, xy }) {
  const p = pep440.tryParse(v);
  if (!p) {
    throw new RefusalError(
      `"${v}" is not a supported version (X.Y.Z or X.Y.Z.devN).`,
      "leave version blank to use the computed version, or fix it.",
    );
  }
  if (p.x !== xy.x || p.y !== xy.y) {
    throw new RefusalError(
      `Version ${v} is not on the ${xy.x}.${xy.y} line of the release branch.`,
      `use a ${xy.x}.${xy.y}.* version, or the release branch for ${p.x}.${p.y}.`,
    );
  }
  if ((p.dev !== null) !== (channel === "dev")) {
    throw new RefusalError(
      `Version ${v} does not match channel=${channel} ` +
        "(dev releases end in .devN, stable ones do not).",
      "fix channel or version so they agree.",
    );
  }
  if (kind === "patch" && p.z === 0) {
    throw new RefusalError(
      `Version ${v} has patch component 0, which is a kind=major release.`,
      "use kind=major, or a version with a non-zero patch component.",
    );
  }
  if (kind === "major" && p.z !== 0) {
    throw new RefusalError(
      `Version ${v} has a non-zero patch component, which is a kind=patch release.`,
      "use kind=patch, or an X.Y.0 version.",
    );
  }
}

/**
 * Plan section 2: major (Z == 0) -> highest stable A.B.0 with (A,B) < (X,Y);
 * patch -> highest stable X.Y.W with W < Z. Dev versions are never candidates.
 */
function previousReleaseTag(v, allVersions, prefix) {
  const p = pep440.parse(v);
  const candidates = (allVersions || [])
    .map((s) => [s, pep440.tryParse(s)])
    .filter(([, q]) => q && q.dev === null)
    .filter(([, q]) =>
      p.z === 0
        ? q.z === 0 && (q.x < p.x || (q.x === p.x && q.y < p.y))
        : q.x === p.x && q.y === p.y && q.z < p.z,
    )
    .map(([s]) => s);
  const best = highest(candidates);
  return best === null ? null : `${prefix}${best}`;
}

/** Plan section 4 "Release flags". */
function releaseFlags(v, allVersions) {
  const prerelease = pep440.isDev(v);
  if (prerelease) return { prerelease: true, make_latest: "false" };
  const top = highestStable([...(allVersions || []), v]);
  return { prerelease: false, make_latest: pep440.compare(v, top) === 0 ? "true" : "false" };
}

/**
 * Plan section 4 "Version resolution": the in-flight version, a typed one,
 * or the computed one; then the downgrade check and the no-skipping rule for
 * a V that is neither in flight nor already released. `released` is the Set
 * of versions with a non-draft release.
 */
function resolveVersion({ typed, inFlight, kind, channel, xy, lineVersions: line, released, branch, prefix }) {
  let version;
  if (typed) {
    checkConsistent(typed, { kind, channel, xy });
    if (inFlight !== null && typed !== inFlight) {
      throw new RefusalError(
        `Release ${inFlight} is in flight on ${branch}; refusing to work on ${typed}.`,
        `leave version blank (or type ${inFlight}) to continue ${inFlight}, or clean it up first.`,
      );
    }
    version = typed;
  } else {
    version = inFlight !== null ? inFlight : computeVersion({ kind, channel, xy, lineVersions: line });
  }
  if (!typed && released.has(version)) {
    throw new RefusalError(
      `The computed version ${version} is already released.`,
      `type version=${version} to re-publish it, or pick another kind/channel.`,
    );
  }
  if (version === inFlight || released.has(version)) return version;
  const top = highest(line);
  if (top !== null && pep440.compare(version, top) <= 0) {
    throw new RefusalError(
      `${version} is not newer than ${prefix}${top}, the highest tag on ${branch} (no downgrades).`,
      "pick a kind/channel whose next version is newer.",
    );
  }
  const computed = typed ? computeVersion({ kind, channel, xy, lineVersions: line }) : version;
  if (computed !== version) {
    throw new RefusalError(
      `Typed version ${typed} is not the next version (${computed}); versions cannot be skipped.`,
      "leave version blank to use the computed version.",
    );
  }
  return version;
}

/** The version at commit_sha must be on the branch's X.Y line. */
function checkCommitShaVersion(versionAtCommit, xy) {
  const p = pep440.tryParse(versionAtCommit);
  if (!p || p.x !== xy.x || p.y !== xy.y) {
    throw new RefusalError(
      `The version files at commit_sha say ${versionAtCommit}, which is not on the ` +
        `${xy.x}.${xy.y} line of the release branch.`,
      `pick a master commit whose version is ${xy.x}.${xy.y}.*, or fix the branch name.`,
    );
  }
}

// One assignment per line: `__version__ = "..."` or `version = "..."` at
// column 0, optional trailing comment, LF or CRLF endings.
const VERSION_LINE_RE =
  /^(__version__|version)([ \t]*=[ \t]*)(["'])([^"'\r\n]+)\3([ \t]*(?:#[^\r\n]*)?)(\r?)$/gm;

function versionMatches(text) {
  if (typeof text !== "string") throw new Error("Version file content must be a string.");
  return [...text.matchAll(VERSION_LINE_RE)];
}

function readVersionFromFile(text) {
  const matches = versionMatches(text);
  if (matches.length !== 1) {
    throw new RefusalError(
      `Expected exactly one \`__version__ = "..."\` or \`version = "..."\` line ` +
        `in the version file, found ${matches.length}.`,
      "fix the version file in the target repo, or version_files in the config.",
    );
  }
  return matches[0][4];
}

function rewriteVersionInFile(text, v) {
  pep440.parse(v);
  readVersionFromFile(text);
  return text.replace(
    VERSION_LINE_RE,
    (_all, name, eq, quote, _old, trailer, cr) => `${name}${eq}${quote}${v}${quote}${trailer}${cr}`,
  );
}

module.exports = {
  branchXY,
  lineVersions,
  highest,
  highestStable,
  checkKindChannel,
  computeVersion,
  checkConsistent,
  previousReleaseTag,
  releaseFlags,
  resolveVersion,
  checkCommitShaVersion,
  readVersionFromFile,
  rewriteVersionInFile,
};
