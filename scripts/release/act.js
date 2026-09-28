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
 * release.yml `act` job (env `release`, App token on the target repo).
 *
 * Order: re-run guard -> inputs -> permission gate -> gatherState -> resolve
 * V and detect the step -> PR/draft lock -> step guards -> legacy guard ->
 * writes. A dry run takes the same path, performs every read and guard, and
 * records "Would ..." instead of each write, plus a discovery report.
 *
 * Writes are limited to: `POST /git/refs` for a new release branch (major,
 * branch absent), force-pushes of `release-tool/*` refs, opening PRs, and
 * `POST /releases` / publishing the bot's draft. Nothing here merges.
 */

const os = require("node:os");
const path = require("node:path");
const { RefusalError } = require("./lib/errors");
const pep440 = require("./lib/pep440");
const version = require("./lib/version");
const { detect, SHA40, BUMP_PREFIX, ABANDONED_LABEL } = require("./lib/detect");
const { prDraftConflicts } = require("./lib/lock");
const { hasWrite, continueGuards, draftAnchorFailures } = require("./lib/guards");
const gitLib = require("./lib/git");
const { Gh, pypiVersions } = require("./lib/gh");
const S = require("./lib/summary");
const plan = require("./plan");
const { prepare, zeroPicksAfterSkips } = require("./prepare");

const DRAFT_WARNING = "> **Do not publish this draft from the GitHub UI**: " +
  "that skips the PyPI upload. Run the Release panel again instead.\n\n";

function refuseIf(failures, what, next) {
  if (failures.length === 0) return;
  throw new RefusalError(`${what}:\n` +
    failures.map((f) => `- ${S.escapeMd(f)}`).join("\n"), next);
}

function tagVersions(tags, prefix) {
  return tags.map((t) => t.name).filter((n) => n.startsWith(prefix))
    .map((n) => n.slice(prefix.length)).filter(pep440.isValid);
}

const tagSha = (ctx, name) =>
  (ctx.state.tags.find((t) => t.name === name) || {}).sha || null;

async function permissionGate(gh, actor) {
  const permission = await gh.permission(actor);
  if (!hasWrite(permission)) {
    throw new RefusalError(`${S.escapeMd(actor || "(unknown)")} has ` +
      `\`${permission}\` permission on ${gh.fullName}; releasing needs write.`,
    "ask someone with write on the target repo to run the release.");
  }
}

/** Refuses unless the legacy publisher is disabled; explicit null skips. */
async function legacyGuard(ctx) {
  const file = ctx.config.legacy_publish_workflow;
  if (file === null) return;
  const { status, state } = await ctx.gh.workflowState(file);
  if (status !== 200 || typeof state !== "string" ||
      !state.startsWith("disabled")) {
    throw new RefusalError(`Legacy publisher \`${file}\` on ${ctx.gh.fullName}` +
      ` is not confirmed disabled (HTTP ${status}, state ` +
      `\`${state || "unknown"}\`); both publishers could upload.`,
    `disable ${file} in the target repo's Actions tab, then run again.`);
  }
}

/** One `POST /releases` creating tag + release (or a draft) at `sha`. */
async function releaseAt(ctx, sha, draft) {
  const { tag, report } = ctx;
  if (!SHA40.test(sha || "")) throw new Error(`release target must be a sha: ${sha}`);
  const flags = version.releaseFlags(ctx.version, ctx.allVersions);
  const prev = version.previousReleaseTag(ctx.version, ctx.allVersions, ctx.prefix);
  const what = draft ? `a draft release ${tag} (no tag yet)` : `release ${tag} with its tag`;
  const detail = `at \`${sha}\` (prerelease ${flags.prerelease}, latest ` +
    `${flags.make_latest}, notes since ${prev || "the first commit"})`;
  if (ctx.dryRun) {
    report.add(`Would create ${what} ${detail}.`);
    return;
  }
  const notes = await ctx.gh.generateNotes(tag, sha, prev);
  const rel = await ctx.gh.createRelease({
    tag_name: tag, target_commitish: sha, draft,
    prerelease: flags.prerelease, make_latest: flags.make_latest,
    name: tag, body: (draft ? DRAFT_WARNING : "") + notes.body,
  });
  report.add(`Created ${what} ${detail}: ${rel.html_url}`);
  if (!draft) ctx.published = true;
}

function releasedNext(ctx) {
  if (ctx.inputs.release_mode === "draft") {
    return "review the draft's notes on GitHub (edit them if needed, but do " +
      "not publish it there), then run the panel again with the same " +
      "repository and branch to publish and upload.";
  }
  return `the dispatch job starts \`publish ${ctx.inputs.repository} ` +
    `${ctx.tag}\`; watch that run for the PyPI upload.`;
}

async function alreadyReleased(ctx) {
  ctx.report.add(`Release ${ctx.tag} is already published; nothing is ` +
    `written to ${ctx.gh.fullName}.`);
  if (ctx.dryRun) {
    ctx.report.add(`Would re-dispatch publish.yml for ${ctx.tag}.`);
    return;
  }
  ctx.published = true;
  ctx.report.setNext(`the dispatch job re-runs \`publish ` +
    `${ctx.inputs.repository} ${ctx.tag}\` (repeat-safe); watch that run.`);
}

async function wait(ctx) {
  const n = ctx.detection.pr.number;
  ctx.report.add(`Waiting for a human with write to merge PR #${n}.`);
  ctx.report.setNext(`a human with write merges PR #${n} (the bot never ` +
    "merges), then run the panel again with the same repository and branch.");
}

async function continueStep(ctx) {
  const { gh, config, detection, report } = ctx;
  const pr = detection.pr;
  const mergeSha = pr.merge_commit_sha;
  const failures = continueGuards({
    pr, config, branch: ctx.branch, version: ctx.version,
    botLogin: ctx.botLogin, targetRepo: gh.fullName,
    mergedByPermission: await gh.permission(pr.merged_by_login),
    versionAtMergeSha: await gh.versionAt(mergeSha, config.version_files),
    tagShaForVersion: tagSha(ctx, ctx.tag),
    highestTagOnLine: version.highest(ctx.lineVersions),
    commitsAfterMerge: await gh.commitsAfter(ctx.branch, mergeSha),
  });
  refuseIf(failures, `Continue guards failed for PR #${pr.number}`,
    `fix the items above, or label PR #${pr.number} \`${ABANDONED_LABEL}\` ` +
    "(someone with write) and run again to cut a version from the branch head.");
  await legacyGuard(ctx);
  if (tagSha(ctx, ctx.tag)) {
    report.add(`Tag ${ctx.tag} already points at the merge sha; not re-tagging.`);
  }
  await releaseAt(ctx, mergeSha, ctx.inputs.release_mode === "draft");
  report.setNext(releasedNext(ctx));
}

/** Fast-path: release the B-head sha resolved at detection time. */
async function fastPath(ctx, { picksSkipped = false } = {}) {
  const { state } = ctx;
  const sha = state.headSha;
  const highest = version.highest(ctx.lineVersions);
  const failures = [];
  if (!sha || state.versionAtHead !== ctx.version) {
    failures.push(`version files at ${ctx.branch} head are ` +
      `${state.versionAtHead}, not ${ctx.version}`);
  }
  if (!picksSkipped && !zeroPicksAfterSkips(ctx)) failures.push("cherry-picks were requested");
  if (tagSha(ctx, ctx.tag)) failures.push(`tag ${ctx.tag} already exists`);
  if (highest && pep440.compare(ctx.version, highest) <= 0) {
    failures.push(`${ctx.version} is not above ${highest}, the highest tag on the line`);
  }
  refuseIf(failures, "Fast-path guards failed",
    "fix the items above, then run again.");
  await legacyGuard(ctx);
  await releaseAt(ctx, sha, ctx.inputs.release_mode === "draft");
  ctx.report.setNext(releasedNext(ctx));
}

async function versionOrNull(ctx, sha) {
  try {
    return await ctx.gh.versionAt(sha, ctx.config.version_files);
  } catch (err) {
    if (err instanceof RefusalError) return null;
    throw err;
  }
}

/**
 * Independent anchor for the draft: the merge sha of the App-authored,
 * human-merged bump-V PR into B; else (fast-path draft) the draft's own
 * target if it is a full sha reachable from B.
 */
async function draftAnchor(ctx, draft) {
  const pr = ctx.state.prs.find((p) => p.merged && !p.abandoned_by_writer &&
    p.base_ref === ctx.branch && p.head_ref === `${BUMP_PREFIX}${ctx.version}` &&
    p.head_repo_full_name === ctx.gh.fullName && p.author_login === ctx.botLogin &&
    p.merged_by_login && p.merged_by_login !== ctx.botLogin);
  if (pr) return pr.merge_commit_sha;
  const target = draft.target_commitish;
  if (SHA40.test(target || "") && await ctx.gh.isAncestor(target, ctx.branch)) {
    return target;
  }
  return null;
}

async function publishStep(ctx) {
  const draft = ctx.detection.draft;
  const target = draft.target_commitish;
  const failures = draftAnchorFailures({
    draft, version: ctx.version, botLogin: ctx.botLogin, prefix: ctx.prefix,
    tagExists: Boolean(tagSha(ctx, ctx.tag)),
    anchorSha: await draftAnchor(ctx, draft),
    versionAtTarget: SHA40.test(target || "") ? await versionOrNull(ctx, target) : null,
  });
  refuseIf(failures, `Draft ${ctx.tag} failed re-verification`,
    "delete the draft (a human-made or edited draft is never published by " +
    "the bot) and run the panel again to recreate it.");
  await legacyGuard(ctx);
  const flags = version.releaseFlags(ctx.version, ctx.allVersions);
  if (ctx.dryRun) {
    ctx.report.add(`Would publish draft ${ctx.tag} at \`${target}\` (creates ` +
      `the tag; latest ${flags.make_latest}).`);
    return;
  }
  const rel = await ctx.gh.publishDraft(draft.id, { make_latest: flags.make_latest });
  ctx.published = true;
  ctx.report.add(`Published draft ${ctx.tag} at \`${target}\`: ${rel.html_url}`);
  ctx.report.setNext(`the dispatch job starts \`publish ${ctx.inputs.repository} ` +
    `${ctx.tag}\`; watch that run for the PyPI upload.`);
}

function tryCompute(args) {
  try {
    return version.computeVersion(args);
  } catch (err) {
    return null;
  }
}

async function discovery(ctx) {
  const { gh, config, state, inputs, detection, report, prefix } = ctx;
  const rows = [];
  for (const branch of await gh.releaseBranches(config.release_branch_pattern)) {
    const xy = version.branchXY(branch, config.release_branch_pattern);
    const lv = version.lineVersions(state.tags, xy, prefix);
    const released = state.releases.filter((r) => !r.draft &&
      lv.includes(r.tag_name.slice(prefix.length)));
    const kind = lv.includes(`${xy.x}.${xy.y}.0`) ? "patch" : "major";
    rows.push({
      branch,
      latest: version.highest(released.map((r) => r.tag_name.slice(prefix.length))),
      nextStable: tryCompute({ kind, channel: "stable", xy, lineVersions: lv }),
      nextDev: tryCompute({ kind, channel: "dev", xy, lineVersions: lv }),
    });
  }
  report.add(S.branchesSection(rows));
  report.add(S.candidatesSection(ctx.branch, state.branchExists ?
    await gh.pickCandidates({ branch: ctx.branch,
      defaultBranch: config.default_branch, picked: state.pickedPrNumbers }) : null));
  report.add(S.listSection("Stale bump PRs (ignored)",
    (detection.stale || []).map((n) => `#${n}`)));
  const isPrepare = detection.step === "prepare";
  report.add(S.formSection({
    repository: inputs.repository, channel: inputs.channel, kind: inputs.kind,
    release_branch: inputs.release_branch,
    commit_sha: isPrepare && !state.branchExists ? inputs.commit_sha : "",
    version: detection.step === "already-released" ? ctx.version : "",
    cherry_picks: isPrepare ? inputs.cherry_picks : "",
    bump_master: isPrepare ? inputs.bump_master : "false",
    release_mode: inputs.release_mode,
    override_generated_tests: inputs.override_generated_tests,
    dry_run: "false",
  }));
  report.add("### Planned actions");
}

const STEPS = {
  "already-released": alreadyReleased,
  "publish": publishStep,
  "resume-continue": continueStep,
  "continue": continueStep,
  "wait": wait,
  "fast-path": (ctx) => fastPath(ctx),
  "prepare": (ctx) => prepare(ctx, { fastPath }),
};

async function main({ github, context, core, env = process.env,
  rootDir = plan.ROOT_DIR, git = gitLib.git, fetchPypi = null }) {
  const report = new S.Report();
  const ctx = { report, published: false, tag: "" };
  try {
    plan.assertFirstAttempt(env);
    const { inputs, config, xy } = plan.loadInputsAndConfig(env, rootDir);
    const slug = plan.requireAppSlug(env);
    const [owner, repo] = plan.resolveTarget(config, context,
      env.RELEASE_TARGET_OWNER, env.RELEASE_TARGET_NAME);
    const gh = new Gh({ github, owner, repo });
    await permissionGate(gh, env.RELEASE_TRIGGERING_ACTOR);
    const botLogin = `${slug}[bot]`;
    const state = await gh.gatherState({
      config, branch: inputs.release_branch, botLogin,
      fetchPypi: fetchPypi || ((pkg) => pypiVersions(pkg, fetch)),
    });
    const detection = detect({ state, inputs, config, botLogin });
    report.setHeader(detection.version, detection.step);
    for (const w of detection.warnings || []) report.warn(w);
    const prefix = config.tag_prefix;
    Object.assign(ctx, {
      gh, git, env, inputs, config, xy, state, detection, botLogin, prefix,
      branch: inputs.release_branch, version: detection.version,
      tag: `${prefix}${detection.version}`, dryRun: inputs.dry_run === "true",
      allVersions: tagVersions(state.tags, prefix),
      lineVersions: version.lineVersions(state.tags, xy, prefix),
      workdir: path.join(env.RUNNER_TEMP || os.tmpdir(), `release-${repo}-${process.pid}`),
    });
    if (ctx.dryRun) await discovery(ctx);
    const conflicts = prDraftConflicts({
      state, step: detection.step, version: detection.version, prefix,
      pattern: config.release_branch_pattern,
    });
    refuseIf(conflicts.map((c) => typeof c === "string" ? c :
      c.reason || c.message || JSON.stringify(c)),
    `Another release is in flight on ${S.escapeMd(inputs.release_branch)}`,
    "finish or close it first, then run again.");
    await STEPS[detection.step](ctx);
    if (ctx.dryRun && detection.step !== "wait") {
      report.setNext("untick dry_run and run again with the form values above.");
    }
  } catch (err) {
    plan.failWith(core, report, err);
  }
  core.setOutput("published", ctx.published && !ctx.dryRun ? "true" : "false");
  core.setOutput("tag", ctx.tag);
  await S.writeSummary(core, report);
}

module.exports = { legacyGuard, main, permissionGate };
