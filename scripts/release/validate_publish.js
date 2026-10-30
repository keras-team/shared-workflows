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
 * publish.yml `validate` job (env `release-read`; read-only App token).
 *
 * - Resolves the actor: the human triggering actor, or `requested_by` only
 *   when the trigger is the release App's own bot; other bots are refused.
 * - The actor must have write on the target repo.
 * - The tag is dereferenced to its commit (annotated tags included); that
 *   sha must be reachable from a release branch, a published non-draft
 *   release must exist for the tag (at that sha when the release records a
 *   sha), and every version file at the sha must equal the tag's version.
 * Outputs `sha` and `version` for the build job.
 */

const { RefusalError } = require("./lib/errors");
const { loadConfig } = require("./lib/config");
const pep440 = require("./lib/pep440");
const { branchXY } = require("./lib/version");
const { hasWrite, resolvePublishActor } = require("./lib/guards");
const { SHA40 } = require("./lib/detect");
const { Gh } = require("./lib/gh");
const S = require("./lib/summary");
const plan = require("./plan");

/** Release branches, the tag's own X.Y line first. */
function linesFirst(branches, pattern, v) {
  const same = (b) => {
    const xy = branchXY(b, pattern);
    return xy.x === v.x && xy.y === v.y;
  };
  return [...branches.filter(same), ...branches.filter((b) => !same(b))];
}

async function validate({ gh, config, actor, tag }) {
  if (!hasWrite(await gh.permission(actor))) {
    throw new RefusalError(`${S.escapeMd(actor)} does not have write on ` +
      `${gh.fullName}.`, "ask someone with write on the target repo to publish.");
  }
  const prefix = config.tag_prefix;
  const version = tag.startsWith(prefix) ? tag.slice(prefix.length) : "";
  let parsed;
  try {
    parsed = pep440.parse(version);
  } catch (err) {
    throw new RefusalError(`Tag "${S.escapeMd(tag)}" is not ${prefix}X.Y.Z or ` +
      `${prefix}X.Y.Z.devN.`, "pass an existing release tag.");
  }
  const sha = await gh.resolveTag(tag);
  if (!sha) {
    throw new RefusalError(`Tag ${S.escapeMd(tag)} does not exist on ${gh.fullName}.`,
      "publish the GitHub release first (run the Release panel).");
  }
  const release = (await gh.listReleases())
    .find((r) => r.tag_name === tag && !r.draft);
  if (!release) {
    throw new RefusalError(`No published (non-draft) release for ${S.escapeMd(tag)}.`,
      "publish the release through the Release panel, then dispatch again.");
  }
  if (SHA40.test(release.target_commitish || "") && release.target_commitish !== sha) {
    throw new RefusalError(`Tag ${S.escapeMd(tag)} points at ${sha}, but its ` +
      `release was made at ${release.target_commitish}: the tag moved.`,
    "restore the tag to the release's commit (rollback team), then dispatch again.");
  }
  let branch = null;
  const branches = await gh.releaseBranches(config.release_branch_pattern);
  for (const b of linesFirst(branches, config.release_branch_pattern, parsed)) {
    if (await gh.isAncestor(sha, b)) {
      branch = b;
      break;
    }
  }
  if (!branch) {
    throw new RefusalError(`${sha} (tag ${S.escapeMd(tag)}) is not reachable ` +
      "from any release branch.", "only commits on a release branch can be published.");
  }
  const atSha = await gh.versionAt(sha, config.version_files);
  if (atSha !== version) {
    throw new RefusalError(`Version files at ${sha} read ${atSha}, not ${version}.`,
      "the tag is on the wrong commit; fix it before publishing.");
  }
  return { sha, version, branch };
}

async function main({ github, context, core, env = process.env,
  rootDir = plan.ROOT_DIR }) {
  const report = new S.Report("Publish validate");
  report.setHeader(null, "validate");
  try {
    if (context.ref !== "refs/heads/main") {
      throw new RefusalError(`publish.yml ran from ${S.escapeMd(context.ref)}; ` +
        "only main may use the App key.", "start the release from the panel on main.");
    }
    const appSlug = plan.requireAppSlug(env);
    const actor = resolvePublishActor({
      triggeringActor: String(env.PUBLISH_TRIGGERING_ACTOR || ""),
      requestedBy: String(env.PUBLISH_REQUESTED_BY || ""), appSlug,
    });
    const repository = String(env.PUBLISH_REPOSITORY || "");
    plan.assertKnownRepository(repository);
    const config = loadConfig(repository, rootDir);
    const [owner, repo] = plan.resolveTarget(config, context,
      env.PUBLISH_TARGET_OWNER, env.PUBLISH_TARGET_NAME);
    const gh = new Gh({ github, owner, repo });
    const tag = String(env.PUBLISH_TAG || "");
    const result = await validate({ gh, config, actor, tag });
    report.setHeader(result.version, "validate");
    core.setOutput("sha", result.sha);
    core.setOutput("version", result.version);
    report.add(`${S.escapeMd(tag)} -> \`${result.sha}\` on ` +
      `${S.escapeMd(result.branch)}; published release found; version files ` +
      `read ${result.version}; actor ${S.escapeMd(actor)} has write.`);
    report.setNext("build, smoke and generated tests run next; upload follows.");
  } catch (err) {
    plan.failWith(core, report, err);
  }
  await S.writeSummary(core, report);
}

module.exports = { main, validate };
