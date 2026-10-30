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
 * release.yml `dispatch` job: starts publish.yml on shared-workflows main.
 *
 * Runs with an App token scoped to shared-workflows and `actions: write`
 * only. Refuses a re-run attempt. `requested_by` is always the triggering
 * actor of this panel run (from env), never a free-text input.
 */

const { RefusalError } = require("./lib/errors");
const pep440 = require("./lib/pep440");
const { Gh } = require("./lib/gh");
const S = require("./lib/summary");
const plan = require("./plan");

const TAG_RE = /^v(\d+\.\d+\.\d+(?:\.dev\d+)?)$/;

async function main({ github, context, core, env = process.env }) {
  const report = new S.Report("Publish dispatch");
  report.setHeader(null, "dispatch");
  try {
    plan.assertFirstAttempt(env);
    const repository = String(env.RELEASE_REPOSITORY || "");
    const tag = String(env.RELEASE_TAG || "");
    const override = String(env.RELEASE_OVERRIDE_GENERATED_TESTS || "");
    const requestedBy = String(env.RELEASE_TRIGGERING_ACTOR || "");
    plan.assertKnownRepository(repository, "start a new panel run.");
    const m = tag.match(TAG_RE);
    if (!m) {
      throw new RefusalError(`act produced no valid tag ("${S.escapeMd(tag)}").`,
        "check the act job's summary.");
    }
    pep440.parse(m[1]);
    report.setHeader(m[1], "dispatch");
    if (override !== "true" && override !== "false") {
      throw new RefusalError(`Invalid override_generated_tests "${S.escapeMd(override)}".`,
        "start a new panel run.");
    }
    if (!requestedBy) {
      throw new RefusalError("The triggering actor is unknown.", "start a new panel run.");
    }
    const { owner, repo } = context.repo;
    const gh = new Gh({ github, owner, repo });
    await gh.dispatch("publish.yml", "main", {
      repository, tag, override_generated_tests: override,
      requested_by: requestedBy,
    });
    const runs = `${context.serverUrl}/${owner}/${repo}/actions/workflows/publish.yml`;
    report.add(`Dispatched \`publish ${repository} ${tag}\` on main ` +
      `(requested by ${S.escapeMd(requestedBy)}, override_generated_tests ` +
      `${override}).`);
    report.setNext(`watch the run titled \`publish ${repository} ${tag}\` at ${runs}.`);
  } catch (err) {
    plan.failWith(core, report, err);
  }
  await S.writeSummary(core, report);
}

module.exports = { main };
