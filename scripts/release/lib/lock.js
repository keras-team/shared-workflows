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
 * Same-branch lock (plan section 4). PURE.
 * - Run signal (`plan` job): other active release.yml / publish.yml runs.
 * - PR and draft signals (`act` job): open bump PRs into B, drafts on B's
 *   line, with exactly the plan's per-step exemptions.
 * Anything that cannot be parsed counts as a conflict (fail closed).
 */

const V = require("./version");
const { BUMP_PREFIX, draftMapsToLine, tagLineXY } = require("./detect");

const ACTIVE_STATUSES = new Set(["requested", "queued", "pending", "waiting", "in_progress"]);
const REPO_TOKEN = /^[a-z0-9][a-z0-9-]*$/;
const KINDS = new Set(["major", "patch"]);

function tokens(title) {
  if (typeof title !== "string") return null;
  const parts = title.split(" ");
  return parts.every((p) => p !== "") ? parts : null;
}

/** `release <repo> <branch> <kind> <version|auto>` (release.yml run-name). */
function parseReleaseTitle(t) {
  const p = tokens(t);
  if (!p || p.length !== 5 || p[0] !== "release") return null;
  const [, repository, branch, kind, version] = p;
  if (!REPO_TOKEN.test(repository) || !KINDS.has(kind)) return null;
  return { repository, branch, kind, version };
}

/** `publish <repo> <tag>` (publish.yml run-name). */
function parsePublishTitle(t) {
  const p = tokens(t);
  if (!p || p.length !== 3 || p[0] !== "publish") return null;
  const [, repository, tag] = p;
  if (!REPO_TOKEN.test(repository)) return null;
  return { repository, tag };
}

/**
 * Active runs that hold the lock for repository+branch. `runs` is
 * [{ id, workflow: "release.yml"|"publish.yml", display_title, status }].
 * Returns [{ run, reason }].
 */
function runConflicts({ runs, selfRunId, repository, branch, pattern, prefix }) {
  const xy = V.branchXY(branch, pattern);
  const out = [];
  for (const run of runs || []) {
    if (!ACTIVE_STATUSES.has(run.status)) continue;
    if (String(run.id) === String(selfRunId)) continue;
    const title = run.display_title;
    if (run.workflow === "release.yml") {
      const parsed = parseReleaseTitle(title);
      if (!parsed) {
        out.push({ run, reason: `release run "${title}" has an unparseable title` });
      } else if (parsed.repository === repository && parsed.branch === branch) {
        out.push({ run, reason: `release run "${title}" is active on ${repository} ${branch}` });
      }
    } else if (run.workflow === "publish.yml") {
      const parsed = parsePublishTitle(title);
      if (!parsed) {
        out.push({ run, reason: `publish run "${title}" has an unparseable title` });
      } else if (parsed.repository === repository && draftMapsToLine(parsed.tag, xy, prefix)) {
        out.push({ run, reason: `publish run "${title}" is active on ${branch}'s line` });
      } else if (parsed.repository === repository && tagLineXY(parsed.tag, prefix) === null) {
        out.push({ run, reason: `publish run "${title}" has an unparseable tag` });
      }
    } else {
      out.push({ run, reason: `run of unexpected workflow "${run.workflow}"` });
    }
  }
  return out;
}

/**
 * PR and draft signals for `state.branch`, after step detection. Exemptions:
 * - wait step: the open `release-tool/bump-<version>` PR into B only;
 * - publish step: the draft whose tag_name is `<prefix><version>` only;
 * - every other step: none.
 * Returns [{ type: "pr"|"draft", number?, tag?, reason }].
 */
function prDraftConflicts({ state, step, version, prefix, pattern }) {
  const xy = V.branchXY(state.branch, pattern);
  const out = [];
  for (const pr of state.prs || []) {
    if (pr.state !== "open" || pr.base_ref !== state.branch) continue;
    if (typeof pr.head_ref !== "string" || !pr.head_ref.startsWith(BUMP_PREFIX)) continue;
    if (step === "wait" && pr.head_ref === `${BUMP_PREFIX}${version}`) continue;
    out.push({
      type: "pr",
      number: pr.number,
      reason: `open bump PR #${pr.number} (${pr.head_ref}) into ${state.branch}`,
    });
  }
  for (const r of state.releases || []) {
    if (!r.draft || !draftMapsToLine(r.tag_name, xy, prefix)) continue;
    if (step === "publish" && r.tag_name === `${prefix}${version}`) continue;
    out.push({
      type: "draft",
      tag: r.tag_name,
      reason: `draft release ${r.tag_name} on ${state.branch}'s line`,
    });
  }
  return out;
}

module.exports = {
  ACTIVE_STATUSES,
  parseReleaseTitle,
  parsePublishTitle,
  runConflicts,
  prDraftConflicts,
};
