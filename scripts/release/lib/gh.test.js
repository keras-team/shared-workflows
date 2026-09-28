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
const T = require("../test_support");
const { Gh, pypiVersions } = require("./gh");
const { refusalMatching } = require("./errors");

const { SHA } = T;

function gh(fixture, fail) {
  const fake = T.fakeGithub(fixture, fail);
  return { fake, gh: new Gh({ github: fake.github, owner: "keras-team", repo: "keras-hub" }) };
}

function stateFixture() {
  const fx = T.baseFixture();
  fx.refs.push({ ref: "refs/tags/v0.33.1", object: { type: "tag", sha: SHA.tagobj } });
  fx.tagObjects = { [SHA.tagobj]: { object: { type: "commit", sha: SHA.ms } } };
  fx.releases.push(T.releaseObj(7, "v0.33.2", SHA.b1, { draft: true }));
  fx.pulls.push(
    T.bumpPr(60, "0.33.1", {
      merged_at: "t", merge_commit_sha: SHA.ms, merged_by: { login: "alice" },
      labels: [{ name: "release-tool:abandoned" }],
    }),
    { ...T.bumpPr(61, "x"), head: { ref: "feature", repo: null }, merged_at: "t",
      body: "Picks\nCherry-picks: #101 (4444444), #102 (5555555)" },
    { ...T.bumpPr(70, "y"), state: "open",
      head: { ref: "release-tool/master-bump-0.34.0.dev0",
        repo: { full_name: "keras-team/keras-hub" } }, base: { ref: "master" } },
    { ...T.bumpPr(71, "0.32.1"), state: "open", base: { ref: "r0.32" } },
    { ...T.bumpPr(72, "z"), head: { ref: "release-tool/master-bump-0.33.0.dev0", repo: null },
      base: { ref: "master" } },
    { ...T.bumpPr(73, "0.33.9"), state: "open", user: { login: "mallory" },
      head: { ref: "release-tool/bump-0.33.9", repo: { full_name: "mallory/keras-hub" } } },
  );
  return fx;
}

const labelEvent = (login) =>
  ({ event: "labeled", label: { name: "release-tool:abandoned" }, actor: { login } });

describe("Gh.gatherState", () => {
  it("dereferences annotated tags and keeps drafts", async () => {
    const { gh: g } = gh(stateFixture());
    const state = await g.gatherState({ config: T.CONFIG, branch: "r0.33" });
    assert.deepEqual(state.tags.find((t) => t.name === "v0.33.1"),
      { name: "v0.33.1", sha: SHA.ms });
    assert.ok(state.releases.some((r) => r.tag_name === "v0.33.2" && r.draft));
    assert.equal(state.releases[0].author_login, T.BOT);
    assert.equal(state.versionAtHead, "0.33.0");
    assert.equal(state.defaultBranchVersion, "0.34.0.dev0");
    assert.equal(state.pypiVersions, null);
  });

  it("keeps same-repo release-tool PRs into the branch and open ones into default, never fork PRs", async () => {
    const { gh: g } = gh(stateFixture());
    const state = await g.gatherState({ config: T.CONFIG, branch: "r0.33" });
    assert.deepEqual(state.prs.map((p) => p.number).sort(), [60, 70]);
    const pr = state.prs.find((p) => p.number === 60);
    assert.equal(pr.merged, true);
    assert.equal(pr.merged_by_login, "alice");
    assert.equal(pr.merge_commit_sha, SHA.ms);
    assert.deepEqual([...state.pickedPrNumbers].sort(), [101, 102]);
  });

  it("honours the abandoned label only when a writer added it last", async () => {
    for (const [events, expected] of [
      [[labelEvent("carol")], false],
      [[labelEvent("alice")], true],
      [[labelEvent("alice"), labelEvent("carol")], false],
      [[], false],
    ]) {
      const fx = stateFixture();
      fx.permissions.carol = "read";
      fx.events = { 60: events };
      const { gh: g } = gh(fx);
      const state = await g.gatherState({ config: T.CONFIG, branch: "r0.33" });
      assert.equal(state.prs.find((p) => p.number === 60).abandoned_by_writer, expected);
    }
  });

  it("reports a missing branch and reads PyPI for packages[0]", async () => {
    const fx = T.baseFixture();
    delete fx.branches["r0.33"];
    const asked = [];
    const { gh: g } = gh(fx);
    const state = await g.gatherState({
      config: T.CONFIG, branch: "r0.33",
      fetchPypi: async (pkg) => { asked.push(pkg); return new Set(["0.33.0"]); },
    });
    assert.equal(state.branchExists, false);
    assert.equal(state.headSha, null);
    assert.equal(state.versionAtHead, null);
    assert.deepEqual(asked, ["keras-hub"]);
  });

  it("refuses when version files disagree", async () => {
    const config = { ...T.CONFIG, version_files: [T.VERSION_FILE, "setup.py"] };
    const fx = T.baseFixture();
    fx.files[`${SHA.b0}:setup.py`] = 'version = "0.32.0"\n';
    const { gh: g } = gh(fx);
    await assert.rejects(g.versionAt(SHA.b0, config.version_files),
      refusalMatching(/disagree/));
  });
});

describe("Gh helpers", () => {
  it("walks the first-parent chain only", async () => {
    const fx = T.baseFixture();
    fx.history = [
      { sha: SHA.master, parents: [SHA.m1, SHA.other] },
      { sha: SHA.other, parents: [SHA.p0] },
      { sha: SHA.m1, parents: [SHA.p0] },
      { sha: SHA.p0, parents: [] },
    ];
    const { gh: g } = gh(fx);
    assert.deepEqual(await g.firstParentShas("master"), [SHA.master, SHA.m1, SHA.p0]);
  });

  it("returns workflow status instead of throwing", async () => {
    const fx = T.baseFixture();
    fx.workflows = { "a.yml": { status: 403 } };
    const { gh: g } = gh(fx);
    assert.deepEqual(await g.workflowState("a.yml"), { status: 403, state: null });
    assert.deepEqual(await g.workflowState("missing.yml"), { status: 404, state: null });
    fx.workflows["a.yml"] = { status: 200, state: "disabled_manually" };
    assert.deepEqual(await g.workflowState("a.yml"), { status: 200, state: "disabled_manually" });
  });

  it("reads .permission and maps 404 to none", async () => {
    const { gh: g } = gh(T.baseFixture());
    assert.equal(await g.permission("alice"), "write");
    assert.equal(await g.permission("stranger"), "none");
  });

  it("lists active runs across every active status, deduplicated", async () => {
    const fx = T.baseFixture();
    fx.runs = { "release.yml": [
      { id: 1, status: "queued", display_title: "release keras-hub r0.33 patch auto" },
      { id: 2, status: "completed", display_title: "release keras-hub r0.33 patch auto" },
      { id: 3, status: "waiting", display_title: "release keras r0.1 patch auto" },
    ] };
    const { gh: g } = gh(fx);
    const runs = await g.listActiveRuns("release.yml");
    assert.deepEqual(runs.map((r) => r.id).sort(), [1, 3]);
    assert.equal(runs[0].workflow, "release.yml");
  });
});

describe("pypiVersions", () => {
  const res = (status, body) => async () =>
    ({ status, ok: status === 200, json: async () => body });
  it("maps 404 to empty, errors to null, 200 to release keys", async () => {
    assert.deepEqual([...await pypiVersions("x", res(404))], []);
    assert.equal(await pypiVersions("x", res(500)), null);
    assert.equal(await pypiVersions("x", async () => { throw new Error("net"); }), null);
    const ok = await pypiVersions("x", res(200, { releases: { "0.33.0": [] } }));
    assert.deepEqual([...ok], ["0.33.0"]);
  });
});
