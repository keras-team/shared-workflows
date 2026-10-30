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
const validatePublish = require("./validate_publish");

const { SHA } = T;
const ROOT = T.configRoot();

/** v0.33.1 is an annotated tag -> ms on r0.33, with a published release. */
function fixture() {
  return {
    branches: { "master": SHA.master, "r0.32": SHA.other, "r0.33": SHA.ms },
    files: { [`${SHA.ms}:${T.VERSION_FILE}`]: T.versionText("0.33.1") },
    refs: [{ ref: "refs/tags/v0.33.1", object: { type: "tag", sha: SHA.tagobj } }],
    tagObjects: { [SHA.tagobj]: { object: { type: "commit", sha: SHA.ms } } },
    releases: [T.releaseObj(3, "v0.33.1", SHA.ms)],
    compares: { [`${SHA.ms}...r0.33`]: { status: "identical", commits: [] } },
    permissions: { alice: "write", mallory: "none" },
  };
}

async function run(fx = fixture(), env = {}, ctx = {}) {
  const gh = T.fakeGithub(fx);
  const core = T.fakeCore();
  await validatePublish.main({
    github: gh.github, context: T.context(ctx), core, rootDir: ROOT,
    env: {
      RELEASE_APP_SLUG: T.SLUG, PUBLISH_TRIGGERING_ACTOR: "alice",
      PUBLISH_REQUESTED_BY: "", PUBLISH_REPOSITORY: "keras-hub",
      PUBLISH_TAG: "v0.33.1", PUBLISH_TARGET_OWNER: "keras-team",
      PUBLISH_TARGET_NAME: "keras-hub", ...env,
    },
  });
  return { gh, core };
}

describe("validate_publish", () => {
  it("dereferences the annotated tag and outputs the commit sha", async () => {
    const { gh, core } = await run();
    assert.equal(core.failed, null);
    assert.equal(core.outputs.sha, SHA.ms);
    assert.notEqual(core.outputs.sha, SHA.tagobj);
    assert.equal(core.outputs.version, "0.33.1");
    assert.deepEqual(gh.writes(), []);
  });

  it("evaluates a human dispatcher as themselves, ignoring requested_by", async () => {
    const { core } = await run(fixture(), { PUBLISH_REQUESTED_BY: "mallory" });
    assert.equal(core.failed, null);
    const denied = await run(fixture(), {
      PUBLISH_TRIGGERING_ACTOR: "mallory", PUBLISH_REQUESTED_BY: "alice",
    });
    assert.match(denied.core.failed, /does not have write/);
  });

  it("uses requested_by when the App bot dispatched", async () => {
    const { core } = await run(fixture(), {
      PUBLISH_TRIGGERING_ACTOR: T.BOT, PUBLISH_REQUESTED_BY: "mallory",
    });
    assert.match(core.failed, /mallory does not have write/);
  });

  it("refuses github-actions[bot] and an empty slug", async () => {
    assert.ok((await run(fixture(), { PUBLISH_TRIGGERING_ACTOR: "github-actions[bot]" })).core.failed);
    assert.match((await run(fixture(), { RELEASE_APP_SLUG: "" })).core.failed, /RELEASE_APP_SLUG/);
  });

  it("refuses when the App token was minted for a different repo", async () => {
    const { gh, core } = await run(fixture(), { PUBLISH_TARGET_OWNER: "someone" });
    assert.match(core.failed, /scoped to/);
    assert.equal(gh.calls.length, 0);
  });

  it("refuses to run from any ref but main, before any API call", async () => {
    const { gh, core } = await run(fixture(), {}, { ref: "refs/heads/feature" });
    assert.match(core.failed, /only main may use the App key/);
    assert.equal(gh.calls.length, 0);
  });

  const negatives = {
    "sha not reachable from a release branch": (fx) => {
      fx.compares[`${SHA.ms}...r0.33`] = { status: "diverged", commits: [] };
    },
    "release is a draft": (fx) => { fx.releases[0].draft = true; },
    "no release at all": (fx) => { fx.releases = []; },
    "tag moved off the release's sha": (fx) => { fx.releases[0].target_commitish = SHA.b0; },
    "version file differs from the tag": (fx) => {
      fx.files[`${SHA.ms}:${T.VERSION_FILE}`] = T.versionText("0.33.0");
    },
    "tag does not exist": (fx) => { fx.refs = []; },
  };
  for (const [name, mutate] of Object.entries(negatives)) {
    it(`refuses when the ${name}`, async () => {
      const fx = fixture();
      mutate(fx);
      const { core } = await run(fx);
      assert.ok(core.failed, name);
      assert.equal(core.outputs.sha, undefined);
    });
  }

  it("refuses a tag that is not vX.Y.Z[.devN]", async () => {
    const { core } = await run(fixture(), { PUBLISH_TAG: "0.33.1" });
    assert.match(core.failed, /is not v/);
  });
});
