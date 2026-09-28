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
 * In-flight scan, version resolution and step detection (plan section 4).
 * PURE: everything comes in through `state` (built by gh.gatherState).
 */

const pep440 = require("./pep440");
const V = require("./version");
const { RefusalError } = require("./errors");
const { parsePicks } = require("./picks");

const BUMP_PREFIX = "release-tool/bump-";
const ABANDONED_LABEL = "release-tool:abandoned";
const SHA40 = /^[0-9a-f]{40}$/i;

/** Version named by a release bump head ref, or null. */
function bumpVersion(headRef) {
  if (typeof headRef !== "string" || !headRef.startsWith(BUMP_PREFIX)) return null;
  const v = headRef.slice(BUMP_PREFIX.length);
  return pep440.isValid(v) ? v : null;
}

/**
 * X.Y of a `<prefix>X.Y...` tag, read loosely so that tags outside the
 * supported version subset still map to a line (fail closed); else null.
 */
function tagLineXY(tag, prefix) {
  if (typeof tag !== "string" || !tag.startsWith(prefix)) return null;
  const m = /^(\d+)\.(\d+)(?:\D|$)/.exec(tag.slice(prefix.length));
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

function draftMapsToLine(tag, xy, prefix) {
  const t = tagLineXY(tag, prefix);
  return t !== null && t.x === xy.x && t.y === xy.y;
}

function isAbandoned(pr) {
  return (pr.labels || []).includes(ABANDONED_LABEL) && pr.abandoned_by_writer === true;
}

/** Bump PRs into the branch, excluding closed-unmerged ones. */
function bumpPrs(state) {
  return (state.prs || [])
    .filter((pr) => pr.base_ref === state.branch && bumpVersion(pr.head_ref) !== null)
    .filter((pr) => pr.state === "open" || pr.merged === true)
    .map((pr) => ({ pr, version: bumpVersion(pr.head_ref) }));
}

function indexState(state, prefix) {
  const tagSha = new Map();
  for (const t of state.tags || []) {
    if (t.name.startsWith(prefix)) tagSha.set(t.name.slice(prefix.length), t.sha);
  }
  const published = new Map();
  const drafts = [];
  for (const r of state.releases || []) {
    if (r.draft) drafts.push(r);
    else if (r.tag_name.startsWith(prefix)) published.set(r.tag_name.slice(prefix.length), r);
  }
  return { tagSha, published, drafts };
}

/** Plan section 4 "In-flight release on B". Returns { signals, stale, warnings }. */
function scanInFlight({ state, prefix, xy, botLogin, idx, lineTop }) {
  const signals = [];
  const stale = [];
  const warnings = [];
  const hasAnyRelease = (v) =>
    idx.published.has(v) || idx.drafts.some((d) => d.tag_name === prefix + v);
  for (const { pr, version } of bumpPrs(state)) {
    if (pr.state === "open") {
      signals.push({ kind: "open-pr", version, pr });
      continue;
    }
    if ((pr.labels || []).includes(ABANDONED_LABEL)) {
      if (isAbandoned(pr)) continue;
      warnings.push(
        `PR #${pr.number} has the ${ABANDONED_LABEL} label, but it was not added ` +
          "by someone with write access, so it is ignored.",
      );
    }
    const sha = idx.tagSha.get(version);
    if (sha !== undefined) {
      if (sha === pr.merge_commit_sha && pr.author_login === botLogin && !hasAnyRelease(version)) {
        signals.push({ kind: "tagged-pr", version, pr });
      } else if (!hasAnyRelease(version)) {
        stale.push({ pr, version });
      }
      continue;
    }
    if (lineTop === null || pep440.compare(version, lineTop) > 0) {
      signals.push({ kind: "merged-pr", version, pr });
    } else {
      stale.push({ pr, version });
    }
  }
  for (const d of idx.drafts) {
    if (!draftMapsToLine(d.tag_name, xy, prefix)) continue;
    const version = d.tag_name.slice(prefix.length);
    if (!pep440.isValid(version)) {
      throw new RefusalError(
        `Draft release "${d.tag_name}" maps to ${state.branch} but is not a version ` +
          "the release tool understands.",
        "delete or publish that draft by hand, then run the panel again.",
      );
    }
    signals.push({ kind: "draft", version, draft: d });
  }
  return { signals, stale, warnings };
}

/** Plan section 4 "Released on GitHub but not on PyPI". */
function pypiCheck({ state, xy, idx }) {
  const released = V.highest([...idx.published.keys()].filter((v) => {
    const p = pep440.tryParse(v);
    return p && p.x === xy.x && p.y === xy.y;
  }));
  if (released === null) return null;
  if (state.pypiVersions === null || state.pypiVersions === undefined) {
    return `Could not check PyPI for ${released}; v${released} may be released on ` +
      "GitHub but not on PyPI.";
  }
  if (!state.pypiVersions.has(released)) {
    return `v${released} is released on GitHub but not on PyPI; run with ` +
      `version=${released} to re-publish.`;
  }
  return null;
}

function refuseIfMultiple(list, what, version) {
  if (list.length > 1) {
    throw new RefusalError(
      `Found ${list.length} ${what} for ${version}; the release tool cannot tell ` +
        "which one to use.",
      "clean up the duplicates by hand, then run the panel again.",
    );
  }
  return list[0];
}

function detect({ state, inputs, config, botLogin }) {
  const prefix = config.tag_prefix;
  const { kind, channel } = inputs;
  V.checkKindChannel(kind, channel);
  const xy = V.branchXY(state.branch, config.release_branch_pattern);
  const idx = indexState(state, prefix);
  const lineTags = V.lineVersions(state.tags, xy, prefix);
  const lineTop = V.highest(lineTags);
  const warnings = [];
  const pypiWarning = pypiCheck({ state, xy, idx });
  if (pypiWarning) warnings.push(pypiWarning);

  const scan = scanInFlight({ state, prefix, xy, botLogin, idx, lineTop });
  warnings.push(...scan.warnings);
  const inFlightVersions = [...new Set(scan.signals.map((s) => s.version))];
  if (inFlightVersions.length > 1) {
    throw new RefusalError(
      `More than one release is in flight on ${state.branch}: ` +
        `${inFlightVersions.join(", ")}.`,
      `finish or clean up all but one (label a merged bump PR ${ABANDONED_LABEL}, ` +
        "close an open one, or delete a draft), then run the panel again.",
    );
  }
  const inFlight = inFlightVersions[0] || null;
  if (inFlight !== null) {
    try {
      V.checkConsistent(inFlight, { kind, channel, xy });
    } catch (e) {
      throw new RefusalError(
        `Release ${inFlight} is in flight on ${state.branch}, but it does not match ` +
          `the inputs: ${e.message}`,
        `rerun with the kind and channel of ${inFlight}, or clean it up first.`,
      );
    }
  }

  const typed = (inputs.version || "").trim().replace(new RegExp(`^${prefix}`), "");
  const version = V.resolveVersion({
    typed, inFlight, kind, channel, xy, lineVersions: lineTags,
    released: new Set(idx.published.keys()), branch: state.branch, prefix,
  });
  const released = idx.published.get(version) || null;

  const stale = scan.stale.filter((s) => s.version !== version).map((s) => s.pr.number);
  const tag = prefix + version;
  const result = (step, extra = {}) => ({ step, version, tag, stale, warnings, ...extra });
  const bumps = bumpPrs(state).filter((b) => b.version === version).map((b) => b.pr);
  const merged = bumps.filter((pr) => pr.merged === true && !isAbandoned(pr));
  const tagSha = idx.tagSha.get(version);

  let detection;
  if (released) {
    detection = result("already-released", { release: released });
  } else if (idx.drafts.some((d) => d.tag_name === tag)) {
    const draft = refuseIfMultiple(idx.drafts.filter((d) => d.tag_name === tag), "drafts", tag);
    detection = result("publish", { draft });
  } else if (tagSha !== undefined) {
    const pr = refuseIfMultiple(merged.filter((p) => p.merge_commit_sha === tagSha), "merged bump PRs", version);
    if (!pr) {
      throw new RefusalError(
        `Tag ${tag} exists at ${tagSha.slice(0, 7)} without a release and not at the ` +
          "merge commit of a release-tool bump PR.",
        `delete the tag ${tag} if it is wrong, or release it by hand.`,
      );
    }
    detection = result("resume-continue", { pr });
  } else if (merged.length) {
    detection = result("continue", { pr: refuseIfMultiple(merged, "merged bump PRs", version) });
  } else if (bumps.some((pr) => pr.state === "open")) {
    detection = result("wait", { pr: bumps.find((pr) => pr.state === "open") });
  } else if (state.branchExists && state.versionAtHead === version && parsePicks(inputs.cherry_picks).length === 0) {
    detection = result("fast-path");
  } else {
    detection = result("prepare");
  }
  checkPrepareOnlyInputs(detection.step, inputs);
  if (detection.step === "prepare") checkPrepare({ state, inputs, pypiWarning });
  return detection;
}

function checkPrepareOnlyInputs(step, inputs) {
  const given = [];
  if (parsePicks(inputs.cherry_picks).length) given.push("cherry_picks");
  if ((inputs.commit_sha || "").trim()) given.push("commit_sha");
  if (inputs.bump_master === "true") given.push("bump_master");
  if (step !== "prepare" && given.length) {
    throw new RefusalError(
      `The detected step is ${step}, which does not use ${given.join(", ")} ` +
        "(they only apply when preparing a new version).",
      `run again without ${given.join(", ")}.`,
    );
  }
}

/** Prepare-step rules that need no I/O. */
function checkPrepare({ state, inputs, pypiWarning }) {
  if (pypiWarning) {
    throw new RefusalError(
      `${pypiWarning} Refusing to prepare a newer version until that is fixed.`,
      "re-publish the missing version first (see the line above).",
    );
  }
  const commitSha = (inputs.commit_sha || "").trim();
  if (!state.branchExists) {
    if (inputs.kind !== "major") {
      throw new RefusalError(
        `Release branch ${state.branch} does not exist; a patch needs an existing branch.`,
        "use kind=major with commit_sha to cut the branch, or fix release_branch.",
      );
    }
    if (!SHA40.test(commitSha)) {
      throw new RefusalError(
        `Release branch ${state.branch} does not exist; commit_sha must be the full ` +
          "40-character master commit to cut it from.",
        "set commit_sha to a full commit sha on the default branch.",
      );
    }
    if (parsePicks(inputs.cherry_picks).length) {
      throw new RefusalError(
        "Cherry-picks are not allowed when cutting a new branch: it is cut from " +
          "commit_sha, which already contains master's fixes.",
        "run again without cherry_picks.",
      );
    }
  } else if (commitSha) {
    throw new RefusalError(
      `Release branch ${state.branch} already exists; commit_sha is only for cutting a new branch.`,
      "run again without commit_sha.",
    );
  }
}

module.exports = {
  detect,
  checkCommitShaVersion: V.checkCommitShaVersion,
  bumpVersion,
  draftMapsToLine,
  tagLineXY,
  BUMP_PREFIX,
  ABANDONED_LABEL,
  SHA40,
};
