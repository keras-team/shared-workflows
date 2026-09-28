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
const dispatch = require("./dispatch");

async function run(env = {}) {
  const gh = T.fakeGithub({});
  const core = T.fakeCore();
  await dispatch.main({
    github: gh.github, context: T.context(), core,
    env: {
      GITHUB_RUN_ATTEMPT: "1", RELEASE_REPOSITORY: "keras-hub",
      RELEASE_TAG: "v0.33.1", RELEASE_OVERRIDE_GENERATED_TESTS: "false",
      RELEASE_TRIGGERING_ACTOR: "alice", GITHUB_TRIGGERING_ACTOR: "mallory",
      ...env,
    },
  });
  return { gh, core };
}

describe("dispatch", () => {
  it("refuses a re-run attempt and dispatches nothing", async () => {
    const { gh, core } = await run({ GITHUB_RUN_ATTEMPT: "2" });
    assert.match(core.failed, /attempt 2/);
    assert.equal(gh.calls.length, 0);
  });

  it("dispatches publish.yml on main with the triggering actor", async () => {
    const { gh, core } = await run({ RELEASE_OVERRIDE_GENERATED_TESTS: "true" });
    assert.equal(core.failed, null);
    const calls = gh.called("actions.createWorkflowDispatch");
    assert.equal(calls.length, 1);
    const p = calls[0].params;
    assert.equal(p.workflow_id, "publish.yml");
    assert.equal(p.ref, "main");
    assert.equal(p.owner, "keras-team");
    assert.equal(p.repo, "shared-workflows");
    assert.deepEqual(p.inputs, {
      repository: "keras-hub", tag: "v0.33.1",
      override_generated_tests: "true", requested_by: "alice",
    });
    assert.match(core.summaryText.split("\n")[0], /0\.33\.1 — step: dispatch/);
    assert.match(core.summaryText.split("\n").at(-1), /^Next: /);
  });

  for (const [name, env] of Object.entries({
    "an empty tag": { RELEASE_TAG: "" },
    "a branch-name tag": { RELEASE_TAG: "r0.33" },
    "an unknown repository": { RELEASE_REPOSITORY: "other" },
    "a non-boolean override": { RELEASE_OVERRIDE_GENERATED_TESTS: "1" },
    "an empty triggering actor": { RELEASE_TRIGGERING_ACTOR: "" },
  })) {
    it(`refuses ${name}`, async () => {
      const { gh, core } = await run(env);
      assert.ok(core.failed);
      assert.equal(gh.called("actions.createWorkflowDispatch").length, 0);
    });
  }
});
