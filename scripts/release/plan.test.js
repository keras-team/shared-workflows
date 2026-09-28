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

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const T = require("./test_support");
const plan = require("./plan");

const ROOT = T.configRoot();

async function run({ runs = {}, env = {}, context = {} } = {}) {
  const gh = T.fakeGithub({ runs });
  const core = T.fakeCore();
  await plan.main({
    github: gh.github, context: T.context(context), core,
    env: T.panelEnv(env), rootDir: ROOT,
  });
  return { gh, core };
}

const run_ = (id, status, title) => ({ id, status, display_title: title });

describe("plan preconditions", () => {
  it("refuses any ref other than main, before any API call", async () => {
    const { gh, core } = await run({ context: { ref: "refs/heads/feature" } });
    assert.match(core.failed, /refs\/heads\/feature/);
    assert.equal(gh.calls.length, 0);
  });

  it("refuses an empty RELEASE_APP_SLUG", async () => {
    const { core } = await run({ env: { RELEASE_APP_SLUG: " " } });
    assert.match(core.failed, /RELEASE_APP_SLUG/);
  });

  const bad = {
    "an unknown repository": { RELEASE_REPOSITORY: "../../etc" },
    "an invalid channel": { RELEASE_CHANNEL: "nightly" },
    "a non-boolean dry_run": { RELEASE_DRY_RUN: "yes" },
    "commit_sha with kind=patch": { RELEASE_COMMIT_SHA: "a".repeat(40) },
    "a malformed commit_sha": { RELEASE_KIND: "major", RELEASE_COMMIT_SHA: "not-a-sha" },
    "a malformed version": { RELEASE_VERSION: "v0.33.1" },
  };
  for (const [name, env] of Object.entries(bad)) {
    it(`refuses ${name}`, async () => {
      const { core } = await run({ env });
      assert.ok(core.failed, name);
      assert.equal(core.outputs.target_owner, undefined);
    });
  }
});

describe("plan run lock", () => {
  it("lists active release.yml and publish.yml runs", async () => {
    const { gh, core } = await run();
    assert.equal(core.failed, null);
    const workflows = new Set(gh.called("actions.listWorkflowRuns")
      .map((c) => c.params.workflow_id));
    assert.deepEqual([...workflows].sort(), ["publish.yml", "release.yml"]);
    assert.equal(core.outputs.target_owner, "keras-team");
    assert.equal(core.outputs.target_name, "keras-hub");
  });

  it("an active publish run on the branch's line refuses; another line does not", async () => {
    const runs = { "publish.yml": [run_(9, "in_progress", "publish keras-hub v0.33.1")] };
    const same = await run({ runs });
    assert.match(same.core.failed, /publish\.yml run 9/);
    const other = await run({ runs, env: { RELEASE_BRANCH: "r0.32" } });
    assert.equal(other.core.failed, null);
  });

  it("ignores its own run and refuses another on the same branch", async () => {
    const own = { "release.yml": [run_(1, "in_progress", "release keras-hub r0.33 patch auto")] };
    assert.equal((await run({ runs: own })).core.failed, null);
    const twin = { "release.yml": [run_(2, "queued", "release keras-hub r0.33 patch 0.33.1")] };
    assert.match((await run({ runs: twin })).core.failed, /Another active run/);
  });

  it("maps a fork owner to the fork's target repo", async () => {
    const { core } = await run({
      context: { repo: { owner: "laxmareddyp", repo: "shared-workflows" } },
    });
    assert.equal(core.outputs.target_owner, "laxmareddyp");
    assert.equal(core.outputs.target_name, "keras-hub");
  });
});

describe("assertFirstAttempt", () => {
  it("accepts attempt 1 only", () => {
    assert.doesNotThrow(() => plan.assertFirstAttempt({ GITHUB_RUN_ATTEMPT: "1" }));
    for (const attempt of ["2", "", undefined]) {
      assert.throws(() => plan.assertFirstAttempt({ GITHUB_RUN_ATTEMPT: attempt }),
        /Re-running/);
    }
  });
});
