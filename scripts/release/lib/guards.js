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
 * Continue guards (plan section 6), draft re-verification (plan section 2),
 * and publish.yml actor resolution (plan section 5). PURE.
 */

const pep440 = require("./pep440");
const { RefusalError } = require("./errors");
const { LOGIN_RE } = require("./config");
const { BUMP_PREFIX, ABANDONED_LABEL, SHA40 } = require("./detect");

/** `.permission` of GET /collaborators/{user}/permission: maintain reads as write. */
function hasWrite(permission) {
  return permission === "admin" || permission === "write";
}

function sameLogin(a, b) {
  return typeof a === "string" && typeof b === "string" && a !== "" &&
    a.toLowerCase() === b.toLowerCase();
}

function versionsAgree(found, version) {
  const list = Array.isArray(found) ? found : [found];
  return list.length > 0 && list.every((v) => v === version);
}

function shortCommit(c) {
  if (typeof c === "string") return c.slice(0, 7);
  const subject = (c.message || "").split("\n")[0];
  return `${String(c.sha).slice(0, 7)} ${subject}`.trim();
}

/**
 * Every continue guard of plan section 6, plus the post-merge-commits
 * refusal. Returns a list of failure messages; empty means pass.
 * `targetRepo` is the base repo full name, used when the PR object has no
 * `base_repo_full_name`.
 */
function continueGuards({
  pr, config, branch, version, botLogin, mergedByPermission, versionAtMergeSha,
  tagShaForVersion, highestTagOnLine, commitsAfterMerge, targetRepo,
}) {
  const f = [];
  if (!config || config.enabled !== true) f.push("the repo is not configured and enabled");
  if (!botLogin) f.push("the App bot login is empty (RELEASE_APP_SLUG unset)");
  if (!pr) return [...f, "there is no bump PR"];
  if (pr.merged !== true) f.push(`PR #${pr.number} is not merged`);
  const pattern = config && config.release_branch_pattern;
  if (!pattern || !new RegExp(pattern).test(pr.base_ref || "") || pr.base_ref !== branch) {
    f.push(`PR #${pr.number} base "${pr.base_ref}" is not the release branch ${branch}`);
  }
  const baseRepo = pr.base_repo_full_name || targetRepo;
  if (!baseRepo || !sameLogin(pr.head_repo_full_name, baseRepo)) {
    f.push(`PR #${pr.number} head repo "${pr.head_repo_full_name}" is not the base repo`);
  }
  if (pr.head_ref !== `${BUMP_PREFIX}${version}`) {
    f.push(`PR #${pr.number} head ref "${pr.head_ref}" is not ${BUMP_PREFIX}${version}`);
  }
  if (!botLogin || !sameLogin(pr.author_login, botLogin)) {
    f.push(`PR #${pr.number} was opened by ${pr.author_login}, not ${botLogin}`);
  }
  if (!pr.merged_by_login || (botLogin && sameLogin(pr.merged_by_login, botLogin))) {
    f.push(`PR #${pr.number} was not merged by a human (merged_by: ${pr.merged_by_login})`);
  }
  if (!hasWrite(mergedByPermission)) {
    f.push(
      `PR #${pr.number} was merged by ${pr.merged_by_login}, whose permission is ` +
        `"${mergedByPermission}" (needs write)`,
    );
  }
  if (!versionsAgree(versionAtMergeSha, version)) {
    f.push(`the version files at the merge commit say ${versionAtMergeSha}, not ${version}`);
  }
  const tagAtMerge = tagShaForVersion && tagShaForVersion === pr.merge_commit_sha;
  if (tagShaForVersion && !tagAtMerge) {
    f.push(`tag v${version} already exists at ${tagShaForVersion.slice(0, 7)}, not at the merge commit`);
  }
  if (highestTagOnLine && pep440.isValid(version)) {
    const c = pep440.compare(version, highestTagOnLine);
    if (c < 0 || (c === 0 && !tagAtMerge)) {
      f.push(`${version} is not newer than the highest tag on the line (${highestTagOnLine})`);
    }
  }
  if (commitsAfterMerge && commitsAfterMerge.length) {
    const n = commitsAfterMerge.length;
    f.push(
      `these ${n} commits would be left out of v${version}: ` +
        `${commitsAfterMerge.map(shortCommit).join("; ")}; label PR #${pr.number} ` +
        `\`${ABANDONED_LABEL}\` and run again to cut a version that includes them`,
    );
  }
  return f;
}

/**
 * Draft publish re-verification (plan section 2). `anchorSha` is recomputed
 * by the caller: the bump PR's merge sha (continue path) or, for a fast-path
 * draft, a sha reachable from B whose version files equal V (null if none).
 */
function draftAnchorFailures({
  draft, version, botLogin, tagExists, anchorSha, versionAtTarget, prefix = "v",
}) {
  const f = [];
  if (!draft) return ["there is no draft"];
  if (draft.draft !== true) f.push(`release ${draft.tag_name} is not a draft`);
  if (!botLogin || !sameLogin(draft.author_login, botLogin)) {
    f.push(`draft ${draft.tag_name} was created by ${draft.author_login}, not ${botLogin}`);
  }
  if (draft.tag_name !== `${prefix}${version}`) {
    f.push(`draft tag "${draft.tag_name}" is not ${prefix}${version}`);
  }
  if (tagExists) f.push(`tag ${prefix}${version} already exists`);
  const target = draft.target_commitish;
  if (typeof target !== "string" || !SHA40.test(target)) {
    f.push(`draft target "${target}" is not a full commit sha`);
  } else if (!anchorSha || target !== anchorSha) {
    f.push(`draft target ${target.slice(0, 7)} is not the verified commit ${anchorSha ? anchorSha.slice(0, 7) : "(none found)"}`);
  }
  if (!versionsAgree(versionAtTarget, version)) {
    f.push(`the version files at the draft target say ${versionAtTarget}, not ${version}`);
  }
  return f;
}

/**
 * publish.yml actor (plan section 5): the App bot may act for `requestedBy`;
 * a human acts for themselves (requestedBy ignored); any other bot is refused.
 */
function resolvePublishActor({ triggeringActor, requestedBy, appSlug }) {
  const slug = (appSlug || "").trim();
  if (!slug) {
    throw new RefusalError("vars.RELEASE_APP_SLUG is empty.", "ask an admin to set the RELEASE_APP_SLUG repo variable.");
  }
  const actor = (triggeringActor || "").trim();
  if (!actor) throw new RefusalError("The triggering actor is empty.");
  if (sameLogin(actor, `${slug}[bot]`)) {
    const who = (requestedBy || "").trim();
    if (!LOGIN_RE.test(who)) {
      throw new RefusalError(
        `Dispatched by ${actor} with an invalid requested_by "${requestedBy}".`,
        "start the release from the panel (release.yml).",
      );
    }
    return who;
  }
  if (actor.toLowerCase().endsWith("[bot]")) {
    throw new RefusalError(
      `${actor} may not run publish.yml; only ${slug}[bot] and humans can.`,
      "start the release from the panel (release.yml).",
    );
  }
  if (!LOGIN_RE.test(actor)) throw new RefusalError(`Invalid triggering actor "${actor}".`);
  return actor;
}

module.exports = { hasWrite, continueGuards, draftAnchorFailures, resolvePublishActor };
