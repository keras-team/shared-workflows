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
 * Cherry-pick selection (plan section 6): parsing, PR validation, merge
 * classification, first-parent ordering, git arguments and the
 * `Cherry-picks:` record line. PURE: callers fetch PR and commit data.
 */

const { RefusalError } = require("./errors");

const PR_TOKEN = /^#([1-9]\d*)$/;
const SHA_TOKEN = /^[0-9a-f]{7,40}$/i;
const LINE_RE = /^[ \t]*Cherry-picks:(.*)$/gim;

/** `#3101, #3110 abc1234` -> [{type:"pr",number}, {type:"sha",sha}]; deduplicated. */
function parsePicks(text) {
  const out = [];
  const seen = new Set();
  for (const token of String(text || "").split(/[\s,]+/).filter(Boolean)) {
    let pick;
    const pr = PR_TOKEN.exec(token);
    if (pr) {
      pick = { type: "pr", number: Number(pr[1]) };
    } else if (SHA_TOKEN.test(token)) {
      pick = { type: "sha", sha: token.toLowerCase() };
    } else {
      throw new RefusalError(
        `"${token}" in cherry_picks is neither a PR number (#3101) nor a commit ` +
          "sha (at least 7 hex characters).",
        "fix cherry_picks and run again.",
      );
    }
    const key = pick.type === "pr" ? `#${pick.number}` : pick.sha;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(pick);
    }
  }
  return out;
}

/** A `#PR` pick must be a PR merged into the default branch. */
function validatePrForPick(pr, defaultBranch) {
  if (!pr || pr.merged !== true || !pr.merge_commit_sha) {
    throw new RefusalError(
      `PR #${pr && pr.number} is not merged, so it cannot be cherry-picked.`,
      "remove it from cherry_picks, or merge it into the default branch first.",
    );
  }
  if (pr.base_ref !== defaultBranch) {
    throw new RefusalError(
      `PR #${pr.number} was merged into ${pr.base_ref}, not ${defaultBranch}.`,
      `only PRs merged into ${defaultBranch} can be cherry-picked.`,
    );
  }
}

/**
 * How a PR landed, from its merge_commit_sha:
 * 2 parents -> "merge"; 1 parent and several commits whose
 * merge_commit_sha~1 also maps to the same PR -> "rebase"; else "squash".
 */
function classifyMerge({ parents, commits, parentMapsToSamePr }) {
  const n = Array.isArray(parents) ? parents.length : parents;
  if (n === 2) return "merge";
  if (n !== 1) throw new RefusalError(`Unsupported commit with ${n} parents.`);
  return commits > 1 && parentMapsToSamePr === true ? "rebase" : "squash";
}

/**
 * Resolves each pick's sha against the default branch's first-parent chain
 * (`git rev-list --first-parent`, newest first) and returns the picks with
 * full shas, oldest first. PR picks must carry `sha` (their merge commit).
 */
function orderPicks(picks, firstParentShas) {
  const chain = (firstParentShas || []).map((s) => s.toLowerCase());
  const resolved = picks.map((pick) => {
    if (!pick.sha) throw new Error(`Pick ${JSON.stringify(pick)} has no sha.`);
    const name = pick.type === "pr" ? `PR #${pick.number} (${pick.sha.slice(0, 7)})` : pick.sha;
    const prefix = pick.sha.toLowerCase();
    const hits = chain.map((s, i) => [s, i]).filter(([s]) => s.startsWith(prefix));
    if (hits.length > 1) {
      throw new RefusalError(
        `Commit ${name} is ambiguous on the default branch.`,
        "use a longer sha prefix.",
      );
    }
    if (!hits.length) {
      throw new RefusalError(
        `Commit ${name} is not on the default branch's first-parent history.`,
        "give the PR number, or the merge commit sha that landed it on the default branch.",
      );
    }
    return { pick: { ...pick, sha: hits[0][0] }, index: hits[0][1] };
  });
  const seen = new Map();
  for (const r of resolved) {
    if (seen.has(r.index)) {
      throw new RefusalError(
        `Picks ${seen.get(r.index)} and ${label(r.pick)} are the same commit.`,
        "list each change once.",
      );
    }
    seen.set(r.index, label(r.pick));
  }
  return resolved.sort((a, b) => b.index - a.index).map((r) => r.pick);
}

function label(pick) {
  return pick.type === "pr" ? `#${pick.number}` : pick.sha.slice(0, 7);
}

/** git arguments for one pick; `method` comes from classifyMerge. */
function cherryPickArgs(pick) {
  if (!pick.sha) throw new Error("Pick has no sha.");
  if (pick.method === "rebase") {
    throw new RefusalError(
      `PR #${pick.number} was rebase-merged, so it has no single commit to pick.`,
      "list the PR's individual commit shas in cherry_picks instead of the PR number.",
    );
  }
  if (pick.method === "merge") return ["cherry-pick", "-x", "-m", "1", pick.sha];
  if (pick.method === "squash") return ["cherry-pick", "-x", pick.sha];
  throw new Error(`Pick ${label(pick)} has unknown method "${pick.method}".`);
}

/** `Cherry-picks: #3101 (abc1234), def5678` or "" for no picks. */
function cherryPicksLine(picks) {
  if (!picks || !picks.length) return "";
  const parts = picks.map((p) =>
    p.type === "pr" ? `#${p.number} (${p.sha.slice(0, 7)})` : p.sha.slice(0, 7),
  );
  return `Cherry-picks: ${parts.join(", ")}`;
}

/** PR numbers named in `Cherry-picks:` lines of the given PR bodies. */
function parseCherryPicksLines(bodies) {
  const out = new Set();
  for (const body of bodies || []) {
    if (typeof body !== "string") continue;
    for (const m of body.matchAll(LINE_RE)) {
      for (const n of m[1].matchAll(/#([1-9]\d*)\b/g)) out.add(Number(n[1]));
    }
  }
  return out;
}

module.exports = {
  parsePicks,
  validatePrForPick,
  classifyMerge,
  orderPicks,
  cherryPickArgs,
  cherryPicksLine,
  parseCherryPicksLines,
};
