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
 * The prepare step of `act` (plan section 4 "State machine" and section 6).
 *
 * - Branch absent (major only): validates `commit_sha` (on the default
 *   branch, X.Y matches the branch name), creates B with `POST /git/refs`,
 *   and stops if B already carries V (F10: the next run is the fast-path).
 * - Branch present: rebuilds `release-tool/bump-V` from scratch as B head +
 *   the picks in master first-parent order (`-x`, `-m 1` for merge commits)
 *   + a version commit (skipped when already at V), force-pushes that bot
 *   ref and opens the PR with a `Cherry-picks:` line. B is never pushed.
 * - Conflict: `cherry-pick --abort`, nothing pushed, refusal lists the
 *   conflicting files and the unselected earlier master commits touching them.
 * - `bump_master`: separate `release-tool/master-bump-<next dev>` PR.
 */

const { RefusalError } = require("./lib/errors");
const pep440 = require("./lib/pep440");
const version = require("./lib/version");
const picksLib = require("./lib/picks");
const { BUMP_PREFIX } = require("./lib/detect");
const { Workspace, withAuthRemote } = require("./lib/git");
const S = require("./lib/summary");

const short = (sha) => sha.slice(0, 7);
const pickLabel = (p) =>
  p.number ? `#${p.number} (${short(p.sha)})` : short(p.sha);

/** True when every requested pick is a PR already listed on B. */
function zeroPicksAfterSkips(ctx) {
  return picksLib.parsePicks(ctx.inputs.cherry_picks).every((p) =>
    p.type === "pr" && ctx.state.pickedPrNumbers.has(p.number));
}

/** Resolves picks to commits, classifies them and sorts oldest first. */
async function resolvePicks(ctx, picks) {
  const { gh } = ctx;
  const defaultBranch = ctx.config.default_branch;
  const bySha = new Map();
  for (const pick of picks) {
    let resolved;
    if (pick.type === "pr") {
      const pr = await gh.pull(pick.number);
      picksLib.validatePrForPick(pr && {
        number: pick.number, merged: pr.merged === true,
        merge_commit_sha: pr.merge_commit_sha, base_ref: pr.base.ref,
      }, defaultBranch);
      const c = await gh.commit(pr.merge_commit_sha);
      const parentMapsToSamePr = c.parents.length === 1 && pr.commits > 1 &&
        (await gh.commitPulls(c.parents[0])).includes(pick.number);
      const method = picksLib.classifyMerge({
        parents: c.parents, commits: pr.commits, parentMapsToSamePr,
      });
      resolved = { type: "pr", number: pick.number, sha: c.sha, method };
    } else {
      const c = await gh.commit(pick.sha);
      if (!c) {
        throw new RefusalError(`Commit ${S.escapeMd(pick.sha)} not found.`,
          "check the SHA and run again.");
      }
      const method = picksLib.classifyMerge({
        parents: c.parents, commits: 1, parentMapsToSamePr: false,
      });
      resolved = { type: "sha", number: null, sha: c.sha, method };
    }
    picksLib.cherryPickArgs(resolved); // refuses a rebase-merged PR up front
    bySha.set(resolved.sha, resolved);
  }
  if (bySha.size === 0) return [];
  return picksLib.orderPicks([...bySha.values()],
    await gh.firstParentShas(defaultBranch));
}

function workspace(ctx) {
  if (ctx.ws) return ctx.ws;
  const token = String(ctx.env.RELEASE_APP_TOKEN || "");
  if (!token) throw new Error("RELEASE_APP_TOKEN is not set in the act step's env.");
  const url = `https://github.com/${ctx.gh.fullName}.git`;
  ctx.ws = new Workspace({
    gitFn: ctx.git, cwd: ctx.workdir, identity: ctx.botLogin,
    pushUrl: withAuthRemote(url, token),
  });
  ctx.ws.clone(url);
  return ctx.ws;
}

function conflictRefusal(ctx, ws, pick, files, selected) {
  const defaultBranch = ctx.config.default_branch;
  const base = ws.mergeBase(ctx.baseSha, `origin/${defaultBranch}`);
  const earlier = ws.commitsTouching(`${base}..${pick.sha}~1`, files)
    .filter((c) => {
      if (selected.has(c.sha)) return false;
      const m = c.subject.match(/\(#(\d+)\)\s*$/);
      return !(m && ctx.state.pickedPrNumbers.has(Number(m[1])));
    });
  const lines = [
    `Cherry-pick of ${pickLabel(pick)} onto ${S.escapeMd(ctx.branch)} ` +
    "conflicts. It was aborted and nothing was pushed.",
    "", "Conflicting files:", ...files.map((f) => `- ${S.escapeMd(f)}`), "",
    `Earlier ${S.escapeMd(defaultBranch)} commits touching those files that ` +
    "were not selected:",
    ...(earlier.length ? earlier.map((c) =>
      `- ${short(c.sha)} ${S.escapeMd(c.subject)}`) : ["- none found"]),
  ];
  return new RefusalError(lines.join("\n"),
    "run again with an adjusted cherry_picks list (e.g. add the prerequisites " +
    "above), or resolve it by hand: a PR onto the branch made with `git " +
    "cherry-pick -x` whose body has a `Cherry-picks:` line, merged by a human; " +
    "then run the panel again.");
}

async function bumpMaster(ctx) {
  const { inputs, config, state, report } = ctx;
  if (inputs.bump_master !== "true") return;
  const v = pep440.parse(ctx.version);
  const nextDev = `${v.x}.${v.y + 1}.0${config.dev_suffix_on_master}`;
  pep440.parse(nextDev);
  const master = config.default_branch;
  if (pep440.compare(state.defaultBranchVersion, nextDev) >= 0) {
    report.add(`Master bump skipped: ${master} is at ` +
      `${state.defaultBranchVersion} (>= ${nextDev}).`);
    return;
  }
  const head = `release-tool/master-bump-${nextDev}`;
  const open = state.prs.find((p) => p.state === "open" &&
    p.head_ref === head && p.base_ref === master);
  if (open) {
    report.add(`Master bump PR #${open.number} is already open.`);
    return;
  }
  if (ctx.dryRun) {
    report.add(`Would open a PR from \`${head}\` bumping ${master} to ${nextDev}.`);
    return;
  }
  const ws = workspace(ctx);
  ws.resetBranch(head, state.defaultHeadSha);
  ws.commitVersion(config.version_files, nextDev, {
    read: version.readVersionFromFile, rewrite: version.rewriteVersionInFile,
    message: `Bump ${master} version to ${nextDev}`,
  });
  ws.pushBotRef(head);
  const pr = await ctx.gh.openPr({
    head, base: master, title: `Bump ${master} version to ${nextDev}`,
    body: `Bumps ${master} to ${nextDev} after ${ctx.tag}. A human with ` +
      "write merges this PR; the bot never merges.",
  });
  report.add(`Opened master bump PR #${pr.number}: ${pr.html_url}`);
}

/**
 * Cuts B at commit_sha. detect.checkPrepare already enforced kind=major, a
 * 40-hex commit_sha and no picks; this adds the checks that need I/O.
 */
async function createBranchAt(ctx) {
  const { gh, inputs, config, report } = ctx;
  const c = await gh.commit(inputs.commit_sha);
  if (!c) {
    throw new RefusalError(`commit_sha ${short(inputs.commit_sha)} was not found.`,
      `give the ${config.default_branch} commit to cut ${ctx.branch} from.`);
  }
  if (!await gh.isAncestor(c.sha, config.default_branch)) {
    throw new RefusalError(`commit_sha ${short(c.sha)} is not on ` +
      `${config.default_branch}.`, `pick a commit from ${config.default_branch}.`);
  }
  const atSha = await gh.versionAt(c.sha, config.version_files);
  version.checkCommitShaVersion(atSha, ctx.xy);
  if (ctx.dryRun) {
    report.add(`Would create branch ${S.escapeMd(ctx.branch)} at \`${c.sha}\`.`);
  } else {
    await gh.createBranch(ctx.branch, c.sha);
    report.add(`Created branch ${S.escapeMd(ctx.branch)} at \`${c.sha}\`.`);
  }
  return { sha: c.sha, versionAtSha: atSha };
}

async function prepare(ctx, { fastPath }) {
  const { gh, inputs, config, state, report } = ctx;
  ctx.baseSha = state.headSha;
  if (!state.branchExists) {
    const cut = await createBranchAt(ctx);
    ctx.baseSha = cut.sha;
    if (cut.versionAtSha === ctx.version) {
      report.add(`${S.escapeMd(ctx.branch)} already carries ${ctx.version}; ` +
        "no bump PR (it would be empty) and no tag in this run.");
      await bumpMaster(ctx);
      report.setNext(`run the panel again with commit_sha blank; the ` +
        `fast-path step will release ${ctx.version}.`);
      return;
    }
  }
  const skipped = [];
  const wanted = picksLib.parsePicks(inputs.cherry_picks).filter((p) => {
    const done = p.type === "pr" && state.pickedPrNumbers.has(p.number);
    if (done) skipped.push(`#${p.number}: already in a Cherry-picks: line on the branch`);
    return !done;
  });
  const picks = await resolvePicks(ctx, wanted);
  const head = `${BUMP_PREFIX}${ctx.version}`;
  if (ctx.dryRun) {
    report.add(`Would rebuild \`${head}\` from ${S.escapeMd(ctx.branch)} at ` +
      `\`${ctx.baseSha}\` with picks in order: ` +
      `${picks.map((p) => `${pickLabel(p)} [${p.method}]`).join(", ") || "none"}` +
      (state.versionAtHead === ctx.version ? "; no version commit (already " +
        `${ctx.version}).` : `; then bump the version to ${ctx.version}.`));
    report.add(S.listSection("Skipped picks", skipped));
    await bumpMaster(ctx);
    return;
  }
  const ws = workspace(ctx);
  ws.resetBranch(head, ctx.baseSha);
  const selected = new Set(picks.map((p) => p.sha));
  const applied = [];
  for (const pick of picks) {
    const out = ws.cherryPick(picksLib.cherryPickArgs(pick));
    if (out.result === "conflict") {
      throw conflictRefusal(ctx, ws, pick, out.files, selected);
    }
    if (out.result === "empty") skipped.push(`${pickLabel(pick)}: empty after cherry-pick`);
    else applied.push(pick);
  }
  const bumped = ws.commitVersion(config.version_files, ctx.version, {
    read: version.readVersionFromFile, rewrite: version.rewriteVersionInFile,
    message: `Bump version to ${ctx.version}`,
  });
  report.add(S.listSection("Skipped picks", skipped));
  if (ws.commitCount(ctx.baseSha) === 0) {
    report.add("Every pick was skipped and the version is already set: no " +
      "PR; continuing as the fast-path step.");
    report.setHeader(null, "fast-path");
    await fastPath(ctx, { picksSkipped: true });
    await bumpMaster(ctx);
    return;
  }
  ws.pushBotRef(head);
  const body = [
    `Prepares ${ctx.tag} on \`${ctx.branch}\`: ${applied.length} cherry-pick(s)` +
    (bumped ? ` and the version bump to ${ctx.version}.` :
      `; the version files already read ${ctx.version}.`), "",
    ...(applied.length ? [picksLib.cherryPicksLine(applied), ""] : []),
    ...(skipped.length ? ["Skipped:", ...skipped.map((s) => `- ${s}`), ""] : []),
    "A human with write merges this PR (the bot never merges). Then run the " +
    `Release panel again with the same repository and branch to release ${ctx.version}.`,
  ].join("\n");
  const pr = await gh.openPr({
    head, base: ctx.branch, title: `Release ${ctx.version}`, body,
  });
  report.add(`Opened PR #${pr.number}: ${pr.html_url}`);
  await bumpMaster(ctx);
  report.setNext(`a human with write reviews and merges PR #${pr.number}, ` +
    "then run the panel again with the same repository and branch.");
}

module.exports = { prepare, resolvePicks, zeroPicksAfterSkips };
