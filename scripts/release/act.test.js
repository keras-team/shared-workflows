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
const act = require("./act");
const { escapeMd } = require("./lib/summary");

const { SHA } = T;
const ROOT = T.configRoot();
const pypi = async () => new Set(["0.33.0"]);

async function run({ fixture, env = {}, git = T.fakeGit(), fail, root = ROOT }) {
  const gh = T.fakeGithub(fixture, fail);
  const core = T.fakeCore();
  await act.main({
    github: gh.github, context: T.context(), core, env: T.panelEnv(env),
    rootDir: root, git: git.fn, fetchPypi: pypi,
  });
  return { gh, core, git };
}

/** r0.33 head = merge sha of bot PR #60 (bump-0.33.1), merged by alice. */
function mergedBump({ tag = false, draft = false } = {}) {
  const fx = T.baseFixture();
  fx.branches["r0.33"] = SHA.ms;
  fx.files[`${SHA.ms}:${T.VERSION_FILE}`] = T.versionText("0.33.1");
  fx.pulls.push(T.bumpPr(60, "0.33.1", {
    merged_at: "2026-09-02T00:00:00Z", merge_commit_sha: SHA.ms,
    merged_by: { login: "alice" }, body: "Cherry-picks: #101 (4444444)",
  }));
  fx.compares[`${SHA.ms}...r0.33`] = { status: "identical", commits: [] };
  if (tag) fx.refs.push({ ref: "refs/tags/v0.33.1", object: { type: "commit", sha: SHA.ms } });
  if (draft) fx.releases.push(T.releaseObj(7, "v0.33.1", SHA.ms, { draft: true }));
  return fx;
}

/** r0.33 head b1 already reads 0.33.1; nothing in flight. */
function fastPathFixture() {
  const fx = T.baseFixture();
  fx.branches["r0.33"] = SHA.b1;
  fx.files[`${SHA.b1}:${T.VERSION_FILE}`] = T.versionText("0.33.1");
  return fx;
}

/** Fake git for a prepare run on top of b0 (0.33.0). */
function prepareGit(overrides = {}) {
  return T.fakeGit((args) => {
    if (overrides[args[0]]) return overrides[args[0]](args);
    if (args[0] === "show") return T.versionText("0.33.0");
    if (args[0] === "hash-object") return "abc123\n";
    if (args[0] === "ls-tree") return `100644 blob abc123\t${T.VERSION_FILE}\n`;
    if (args[0] === "rev-list") return "2\n";
    return "";
  });
}

const lines = (core) => core.summaryText.split("\n");

describe("act gates", () => {
  it("refuses a re-run attempt before any API call", async () => {
    const { gh, core } = await run({ fixture: T.baseFixture(), env: { GITHUB_RUN_ATTEMPT: "2" } });
    assert.match(core.failed, /attempt 2/);
    assert.equal(gh.calls.length, 0);
    assert.equal(core.outputs.published, "false");
  });

  for (const permission of ["read", "none"]) {
    it(`refuses an actor whose .permission is ${permission} (triage reports read)`, async () => {
      const fx = T.baseFixture();
      fx.permissions.alice = permission;
      const { gh, core } = await run({ fixture: fx, env: { RELEASE_DRY_RUN: "true" } });
      assert.match(core.failed, /needs write/);
      assert.equal(gh.called("repos.listReleases").length, 0);
    });
  }

  it("allows maintain, which .permission reports as write", async () => {
    const { core } = await run({ fixture: T.baseFixture(), env: { RELEASE_DRY_RUN: "true" } });
    assert.equal(core.failed, null);
  });

  it("refuses when the App token was minted for a different repo", async () => {
    const { gh, core } = await run({
      fixture: T.baseFixture(), env: { RELEASE_TARGET_NAME: "keras" },
    });
    assert.match(core.failed, /scoped to/);
    assert.equal(gh.calls.length, 0);
  });
});

describe("act dry run", () => {
  it("prepare: zero writes, discovery report, escaped titles", async () => {
    const git = T.fakeGit();
    const { gh, core } = await run({
      fixture: T.baseFixture(), git,
      env: { RELEASE_DRY_RUN: "true", RELEASE_CHERRY_PICKS: "#101" },
    });
    assert.equal(core.failed, null);
    assert.deepEqual(gh.writes(), []);
    assert.equal(gh.called("repos.generateReleaseNotes").length, 0);
    assert.equal(git.calls.length, 0);
    assert.equal(core.outputs.published, "false");
    assert.match(lines(core)[0], /0\.33\.1/);
    assert.match(lines(core)[0], /prepare/);
    assert.match(lines(core).at(-1), /^Next: /);
    for (const text of ["Release branches", "Would rebuild", "Form values"]) {
      assert.ok(core.summaryText.includes(text), text);
    }
    assert.ok(core.summaryText.includes(escapeMd("Fix *thing* <x>")));
    assert.ok(!core.summaryText.includes("Fix *thing* <x>"));
  });

  it("draft present: reports the publish step and writes nothing", async () => {
    const { gh, core } = await run({ fixture: mergedBump({ draft: true }), env: { RELEASE_DRY_RUN: "true" } });
    assert.equal(core.failed, null);
    assert.deepEqual(gh.writes(), []);
    assert.match(lines(core)[0], /publish/);
    assert.ok(core.summaryText.includes("Would publish draft v0.33.1"));
    assert.equal(core.outputs.published, "false");
  });
});

describe("act idempotent resume", () => {
  it("partial prepare: rebuilds the bot ref from B head, opens one PR", async () => {
    const fx = T.baseFixture();
    fx.pulls.push(T.bumpPr(50, "0.33.1"));
    const git = prepareGit();
    const { gh, core } = await run({ fixture: fx, git, env: { RELEASE_CHERRY_PICKS: "#101" } });
    assert.equal(core.failed, null);
    const created = gh.called("pulls.create");
    assert.equal(created.length, 1);
    assert.equal(created[0].params.head, "release-tool/bump-0.33.1");
    assert.equal(created[0].params.base, "r0.33");
    assert.match(created[0].params.body, /^Cherry-picks: #101/m);
    assert.equal(gh.called("git.createRef").length, 0);
    const checkout = git.calls.find((c) => c.args[0] === "checkout");
    assert.deepEqual(checkout.args.slice(-3), ["-B", "release-tool/bump-0.33.1", SHA.b0]);
    const pick = git.calls.find((c) => c.args[0] === "cherry-pick");
    assert.ok(pick.args.includes("-x") && pick.args.includes(SHA.m1));
    const pushes = git.pushes();
    assert.equal(pushes.length, 1);
    assert.ok(pushes[0].args.includes("HEAD:refs/heads/release-tool/bump-0.33.1"));
    assert.ok(pushes[0].args.includes("--force"));
    const clone = git.calls.find((c) => c.args[0] === "clone");
    assert.ok(!clone.args.join(" ").includes("test-token"));
    assert.equal(core.outputs.published, "false");
  });

  it("tag without release: one POST /releases, no re-tag", async () => {
    const { gh, core } = await run({ fixture: mergedBump({ tag: true }) });
    assert.equal(core.failed, null);
    assert.match(lines(core)[0], /resume-continue/);
    const rel = gh.called("repos.createRelease");
    assert.equal(rel.length, 1);
    assert.equal(rel[0].params.tag_name, "v0.33.1");
    assert.equal(rel[0].params.target_commitish, SHA.ms);
    assert.equal(gh.called("git.createRef").length, 0);
    assert.equal(core.outputs.published, "true");
    assert.equal(core.outputs.tag, "v0.33.1");
  });

  it("draft present (blank version): publishes the bot draft only", async () => {
    const { gh, core } = await run({ fixture: mergedBump({ draft: true }) });
    assert.equal(core.failed, null);
    const upd = gh.called("repos.updateRelease");
    assert.equal(upd.length, 1);
    assert.equal(upd[0].params.release_id, 7);
    assert.equal(upd[0].params.draft, false);
    assert.equal(gh.called("repos.createRelease").length, 0);
    assert.equal(core.outputs.published, "true");
  });
});

describe("act cherry-pick conflict", () => {
  it("aborts, pushes nothing, reports files and unselected commits", async () => {
    const git = prepareGit({
      "cherry-pick": (args) => {
        if (args[1] === "--abort") return "";
        throw Object.assign(new Error("conflict"),
          { stdout: "", stderr: "CONFLICT (content): Merge conflict in keras_hub/a.py" });
      },
      "diff": () => "keras_hub/a.py\n",
      "merge-base": () => `${SHA.p0}\n`,
      "log": () => `${SHA.m0}\tRefactor a (#99)\n`,
    });
    const { gh, core } = await run({ fixture: T.baseFixture(), git, env: { RELEASE_CHERRY_PICKS: "#101" } });
    assert.match(core.failed, /conflicts/);
    assert.deepEqual(gh.writes(), []);
    assert.equal(git.pushes().length, 0);
    assert.ok(git.calls.some((c) => c.args.join(" ") === "cherry-pick --abort"));
    assert.ok(core.summaryText.includes(escapeMd("keras_hub/a.py")));
    assert.ok(core.summaryText.includes(SHA.m0.slice(0, 7)));
    assert.equal(core.outputs.published, "false");
  });
});

describe("act atomic release", () => {
  it("continue makes exactly one POST /releases with tag + sha", async () => {
    const { gh, core } = await run({ fixture: mergedBump() });
    assert.equal(core.failed, null);
    assert.match(lines(core)[0], /continue/);
    const writes = gh.writes();
    assert.deepEqual(writes.map((w) => w.name), ["repos.createRelease"]);
    assert.equal(writes[0].params.tag_name, "v0.33.1");
    assert.equal(writes[0].params.target_commitish, SHA.ms);
    assert.equal(writes[0].params.draft, false);
    const notes = gh.called("repos.generateReleaseNotes")[0].params;
    assert.equal(notes.previous_tag_name, "v0.33.0");
  });

  it("a failed release call leaves no tag behind", async () => {
    const { gh, core } = await run({ fixture: mergedBump(), fail: { createRelease: true } });
    assert.ok(core.failed);
    assert.deepEqual(gh.writes().map((w) => w.name), ["repos.createRelease"]);
    assert.equal(core.outputs.published, "false");
  });
});

describe("act fast-path", () => {
  for (const mode of ["auto", "draft"]) {
    it(`${mode}: targets the resolved sha, never the branch name`, async () => {
      const { gh, core } = await run({ fixture: fastPathFixture(), env: { RELEASE_MODE: mode } });
      assert.equal(core.failed, null);
      assert.match(lines(core)[0], /fast-path/);
      const rel = gh.called("repos.createRelease");
      assert.equal(rel.length, 1);
      assert.equal(rel[0].params.target_commitish, SHA.b1);
      assert.equal(rel[0].params.draft, mode === "draft");
      assert.equal(core.outputs.published, mode === "auto" ? "true" : "false");
    });
  }
});

describe("act legacy publisher guard", () => {
  const cases = {
    "HTTP 403": { status: 403 },
    "HTTP 404": undefined,
    "active": { status: 200, state: "active" },
  };
  for (const [name, workflow] of Object.entries(cases)) {
    it(`refuses when the workflow lookup is ${name}`, async () => {
      const fx = fastPathFixture();
      fx.workflows = workflow ? { "publish-to-pypi.yml": workflow } : {};
      const { gh, core } = await run({ fixture: fx });
      assert.match(core.failed, /publish-to-pypi\.yml/);
      assert.deepEqual(gh.writes(), []);
    });
  }

  it("is skipped only for an explicit null", async () => {
    const root = T.configRoot({ legacy_publish_workflow: null });
    const { gh, core } = await run({ fixture: fastPathFixture(), root });
    assert.equal(core.failed, null);
    assert.equal(gh.called("actions.getWorkflow").length, 0);
    assert.equal(gh.called("repos.createRelease").length, 1);
  });
});

describe("act already-released", () => {
  it("typed version with a published release: no writes, published=true", async () => {
    const git = T.fakeGit();
    const { gh, core } = await run({
      fixture: T.baseFixture(), git,
      env: { RELEASE_VERSION: "0.33.0", RELEASE_KIND: "major" },
    });
    assert.equal(core.failed, null);
    assert.match(lines(core)[0], /already-released/);
    assert.deepEqual(gh.writes(), []);
    assert.equal(git.calls.length, 0);
    assert.equal(core.outputs.published, "true");
    assert.equal(core.outputs.tag, "v0.33.0");
  });
});
