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
 * YAML-bound tests for release.yml, publish.yml and test.yml (plan section 7).
 *
 * Every check reads the real workflow files through yaml_lite.js; gate
 * conditions are the literal `if:` strings evaluated by expr.js. There is no
 * separately maintained JS mirror of any workflow logic.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const yaml = require("./yaml_lite.js");
const { evaluate, evaluateJobIf, ExprError } = require("./expr.js");

const WORKFLOW_DIR = path.resolve(__dirname, "..", "..", ".github", "workflows");
const load = (name) => yaml.parseFile(path.join(WORKFLOW_DIR, name));
const release = load("release.yml");
const publish = load("publish.yml");
const tests = load("test.yml");
const RELEASE_WORKFLOWS = { "release.yml": release, "publish.yml": publish };
const ALL_WORKFLOWS = { ...RELEASE_WORKFLOWS, "test.yml": tests };

const CHECKOUT = "actions/checkout";
const APP_TOKEN = "actions/create-github-app-token";

// Plan section 5, verbatim.
const UPLOAD_GATE =
  "always() && github.repository == 'keras-team/shared-workflows' && " +
  "github.ref == 'refs/heads/main' && needs.validate.result == 'success' && " +
  "needs.build.result == 'success' && needs.smoke.result == 'success' && " +
  "(needs.generated-tests.result == 'success' || " +
  "(inputs.override_generated_tests == true && " +
  "needs.generated-tests.result == 'failure'))";
// Plan section 4, verbatim.
const DISPATCH_IF = "inputs.dry_run == false && needs.act.outputs.published == 'true'";
const GENERATED_TESTS_IF = "always() && needs.build.result == 'success'";

// Plan section 4 "Field labels", verbatim, in form order.
const RELEASE_INPUTS = [
  ["repository", "choice", "Which repo to release (must be enabled in release/repos/)."],
  ["channel", "choice", "dev = pre-release X.Y.Z.devN (GitHub pre-release); stable = final release."],
  ["kind", "choice", "major = new X.Y line on a release branch (patch component 0); patch = X.Y.Z fix on an existing release branch."],
  ["release_branch", "string", "Release branch, e.g. r0.33. Always required; used for the same-branch lock."],
  ["commit_sha", "string", "Major with a new branch only: the master commit to cut the branch from."],
  ["version", "string", "Optional. Leave blank to use the computed version (the dry run shows it). Type one only to resume or re-publish a specific version."],
  ["cherry_picks", "string", "Master PR numbers (recommended, e.g. #3101) or commit SHAs, any order; applied in master merge order. Allowed for patch, and for major when the release branch already exists (e.g. fixes before X.Y.0)."],
  ["bump_master", "boolean", "Also open a PR bumping master to the next dev version."],
  ["release_mode", "choice", "auto: after you merge the version PR and run the panel again, tags, publishes the GitHub release and uploads to PyPI in one go. draft: creates a draft release with notes for you to review (no tag yet); run the panel again to publish, which creates the tag and uploads. The bot never merges the PR in either mode."],
  ["override_generated_tests", "boolean", "Upload even if the Gemini-generated tests fail (e.g. a wrong generated test or a Gemini outage). The smoke install/import test always blocks."],
  ["dry_run", "boolean", "Show what would happen and change nothing. Untick to act."],
];

// Jobs that hold a secret or an OIDC token. No cache restore is allowed here.
const PRIVILEGED = {
  "release.yml/act": "release",
  "release.yml/dispatch": "release",
  "publish.yml/validate": "release-read",
  "publish.yml/generate": "gemini",
  "publish.yml/upload": "pypi",
};

// Plan sections 4-5: owner, repositories and permission-* of every App token.
const TOKEN_SPECS = {
  "release.yml/act": {
    owner: "${{ needs.plan.outputs.target_owner }}",
    repositories: "${{ needs.plan.outputs.target_name }}",
    real: { contents: "write", "pull-requests": "write", workflows: "write", actions: "read", metadata: "read" },
    // Dry run: contents write for draft visibility, the rest read; `workflows`
    // has no read level on GitHub, so it is omitted.
    dry: { contents: "write", "pull-requests": "read", actions: "read", metadata: "read" },
  },
  "release.yml/dispatch": {
    owner: "${{ github.repository_owner }}",
    repositories: "shared-workflows",
    real: { actions: "write" },
    dry: { actions: "write" },
  },
  "publish.yml/validate": {
    owner: "${{ steps.target.outputs.owner }}",
    repositories: "${{ steps.target.outputs.name }}",
    real: { metadata: "read", contents: "read" },
    dry: { metadata: "read", contents: "read" },
  },
};

function jobs(wf) {
  return Object.entries(wf.jobs);
}

function allJobs(workflows = ALL_WORKFLOWS) {
  const out = [];
  for (const [file, wf] of Object.entries(workflows)) {
    for (const [name, job] of jobs(wf)) out.push({ id: `${file}/${name}`, file, name, job });
  }
  return out;
}

function allSteps(workflows = ALL_WORKFLOWS) {
  const out = [];
  for (const j of allJobs(workflows)) {
    (j.job.steps || []).forEach((step, index) => out.push({ ...j, step, index }));
  }
  return out;
}

function action(step) {
  return typeof step.uses === "string" ? step.uses.split("@")[0] : null;
}

function envName(job) {
  if (job.environment === undefined || job.environment === null) return null;
  return typeof job.environment === "string" ? job.environment : job.environment.name;
}

function gateContext(needsList, { results = {}, override = false, repository, ref } = {}) {
  const needs = {};
  for (const n of needsList) needs[n] = { result: results[n] || "success" };
  return {
    github: {
      repository: repository || "keras-team/shared-workflows",
      ref: ref || "refs/heads/main",
    },
    inputs: { override_generated_tests: override },
    needs,
  };
}

// ---------------------------------------------------------------- helpers ---

test("yaml_lite reads the workflow subset and rejects what it cannot read", () => {
  const doc = yaml.parse([
    "a: 'it''s' # comment",
    'b: "x: y"',
    "c: [one, 'two']",
    "d: |",
    "  line 1",
    "    indented",
    "e: >-",
    "  folded",
    "  text",
    "f:",
    "- 1",
    "- k: v",
    "  j: w",
    "g: {}",
    "h: plain # trailing",
    "",
  ].join("\n"));
  assert.deepEqual(doc, {
    a: "it's",
    b: "x: y",
    c: ["one", "two"],
    d: "line 1\n  indented\n",
    e: "folded text",
    f: ["1", { k: "v", j: "w" }],
    g: {},
    h: "plain",
  });
  assert.throws(() => yaml.parse("a: 1\na: 2\n"), /duplicate key/);
  assert.throws(() => yaml.parse("a: &x 1\n"), /anchors/);
  assert.throws(() => yaml.parse("a: {b: 1}\n"), /flow mappings/);
  assert.throws(() => yaml.parse("a: b\n  c\n"), /multi-line plain/);
  assert.throws(() => yaml.parse("a:\n\tb: 1\n"), /tab/);
});

test("expr evaluates like the Actions runner", () => {
  const ctx = { inputs: { dry_run: true }, needs: { a: { result: "success" } }, github: { ref: "refs/heads/main" } };
  assert.equal(evaluate("${{ inputs.dry_run && 'read' || 'write' }}", ctx), "read");
  assert.equal(evaluate("inputs.dry_run == false", ctx), false);
  assert.equal(evaluate("github.ref == 'REFS/HEADS/MAIN'", ctx), true); // case-insensitive
  assert.equal(evaluate("'1' == 1", ctx), true); // loose equality
  assert.equal(evaluate("'true' == true", ctx), false); // NaN != 1
  assert.equal(evaluate("!(needs.a.result != 'success')", ctx), true);
  assert.equal(evaluate("needs.missing.result", ctx), null);
  assert.throws(() => evaluate("input.dry_run", ctx), ExprError);
  assert.throws(() => evaluate("contains(inputs.x, 'y')", ctx), ExprError);
  // Implicit success(): a failed need blocks an if: without a status call.
  const failed = { ...ctx, needs: { a: { result: "failure" } } };
  assert.equal(evaluateJobIf("true", failed), false);
  assert.equal(evaluateJobIf("always() && true", failed), true);
});

// ------------------------------------------------------ triggers / inputs ---

test("both release workflows are workflow_dispatch only with contents: read", () => {
  for (const [file, wf] of Object.entries(RELEASE_WORKFLOWS)) {
    assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"], file);
    assert.deepEqual(wf.permissions, { contents: "read" }, file);
    assert.equal(wf.concurrency, undefined, `${file} must not have workflow-level concurrency`);
  }
});

test("release.yml has exactly the 11 plan inputs with verbatim labels", () => {
  const inputs = release.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), RELEASE_INPUTS.map(([n]) => n));
  for (const [name, type, description] of RELEASE_INPUTS) {
    assert.equal(inputs[name].type, type, `${name} type`);
    assert.equal(inputs[name].description, description, `${name} description`);
  }
  assert.deepEqual(inputs.repository.options, ["keras", "keras-hub", "keras-rs", "kinetic"]);
  assert.deepEqual(inputs.channel.options, ["dev", "stable"]);
  assert.deepEqual(inputs.kind.options, ["major", "patch"]);
  assert.deepEqual([...inputs.release_mode.options].sort(), ["auto", "draft"]);
  assert.equal(inputs.release_branch.required, "true");
  assert.equal(inputs.version.required, "false");
  assert.equal(inputs.dry_run.default, "true");
  assert.equal(inputs.bump_master.default, "false");
  assert.equal(inputs.override_generated_tests.default, "false");
  assert.equal(inputs.action, undefined, "there is no action input");
});

test("publish.yml inputs and both run-names", () => {
  const inputs = publish.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ["repository", "tag", "override_generated_tests", "requested_by"]);
  assert.equal(inputs.repository.type, "choice");
  assert.equal(inputs.tag.type, "string");
  assert.equal(inputs.override_generated_tests.type, "boolean");
  assert.equal(inputs.override_generated_tests.default, "false");
  assert.equal(inputs.requested_by.type, "string");
  assert.equal(inputs.requested_by.required, "false");
  assert.equal(publish["run-name"], "publish ${{ inputs.repository }} ${{ inputs.tag }}");
  assert.equal(
    release["run-name"],
    "release ${{ inputs.repository }} ${{ inputs.release_branch }} ${{ inputs.kind }} ${{ inputs.version || 'auto' }}",
  );
});

// ------------------------------------------- environments / permissions ---

test("environments: only act/dispatch release, validate release-read, generate gemini, upload pypi", () => {
  const actual = {};
  for (const { id, job } of allJobs()) {
    const env = envName(job);
    if (env !== null) actual[id] = env;
  }
  assert.deepEqual(actual, PRIVILEGED);
});

test("id-token: write only on upload; every other job-level permission is read", () => {
  for (const { id, job } of allJobs()) {
    for (const [scope, level] of Object.entries(job.permissions || {})) {
      if (scope === "id-token") {
        assert.equal(id, "publish.yml/upload", `${id} must not request id-token`);
        assert.equal(level, "write");
      } else {
        assert.equal(level, "read", `${id} ${scope}`);
      }
    }
  }
  assert.deepEqual(publish.jobs.upload.permissions, { "id-token": "write", contents: "read" });
  assert.deepEqual(release.jobs.plan.permissions, { actions: "read", contents: "read" });
  for (const wf of Object.values(ALL_WORKFLOWS)) {
    assert.equal((wf.permissions || {})["id-token"], undefined);
  }
});

test("secrets appear only in environment jobs, and only the expected ones", () => {
  const expected = {
    "release.yml/act": ["RELEASE_APP_CLIENT_ID", "RELEASE_APP_PRIVATE_KEY"],
    "release.yml/dispatch": ["RELEASE_APP_CLIENT_ID", "RELEASE_APP_PRIVATE_KEY"],
    "publish.yml/validate": ["RELEASE_APP_CLIENT_ID", "RELEASE_APP_PRIVATE_KEY"],
    "publish.yml/generate": ["GEMINI_API"],
  };
  for (const { id, job } of allJobs()) {
    const used = [...new Set((JSON.stringify(job).match(/secrets\.[A-Za-z0-9_]+/g) || []).map((s) => s.slice(8)))].sort();
    assert.deepEqual(used, expected[id] || [], id);
  }
  for (const [file, wf] of Object.entries(ALL_WORKFLOWS)) {
    assert.ok(!JSON.stringify(wf.env || {}).includes("secrets."), `${file} workflow env`);
  }
  // GEMINI_API only in the step that runs the generator.
  const geminiSteps = allSteps().filter(({ step }) => JSON.stringify(step).includes("secrets.GEMINI_API"));
  assert.equal(geminiSteps.length, 1);
  assert.equal(geminiSteps[0].step.run, "python -I sw/scripts/release/py/generate_test.py");
  assert.deepEqual(Object.keys(geminiSteps[0].step.env).filter((k) => k.includes("GEMINI")), ["GEMINI_API_KEY"]);
});

test("App tokens never leave their job", () => {
  for (const { id, job } of allJobs()) {
    assert.ok(!JSON.stringify(job.outputs || {}).includes("app-token"), `${id} outputs`);
    for (const step of job.steps || []) {
      if (action(step) === APP_TOKEN) {
        assert.equal((step.with || {})["skip-token-revoke"], undefined, `${id} must keep token revocation`);
      }
    }
  }
});

test("each create-github-app-token step has the plan's owner, repositories and permissions", () => {
  const tokenSteps = allSteps().filter(({ step }) => action(step) === APP_TOKEN);
  assert.deepEqual(tokenSteps.map((s) => s.id).sort(), Object.keys(TOKEN_SPECS).sort());
  for (const { id, step } of tokenSteps) {
    const spec = TOKEN_SPECS[id];
    const w = step.with;
    assert.equal(w.owner, spec.owner, `${id} owner`);
    assert.equal(w.repositories, spec.repositories, `${id} repositories`);
    for (const dryRun of [true, false]) {
      const perms = {};
      for (const [key, raw] of Object.entries(w)) {
        if (!key.startsWith("permission-")) continue;
        const value = raw.includes("${{") ? evaluate(raw, { inputs: { dry_run: dryRun } }) : raw;
        if (value !== "") perms[key.slice("permission-".length)] = value;
      }
      assert.deepEqual(perms, dryRun ? spec.dry : spec.real, `${id} dry_run=${dryRun}`);
    }
  }
});

// ------------------------------------------------------------- gates ---

test("dispatch.if is exactly the plan's condition and behaves", () => {
  const job = release.jobs.dispatch;
  assert.equal(job.if, DISPATCH_IF);
  const ctx = (dryRun, published, actResult = "success") => ({
    inputs: { dry_run: dryRun },
    needs: { act: { result: actResult, outputs: { published } } },
  });
  assert.equal(evaluateJobIf(job.if, ctx(false, "true")), true);
  assert.equal(evaluateJobIf(job.if, ctx(true, "true")), false);
  assert.equal(evaluateJobIf(job.if, ctx(false, "false")), false);
  assert.equal(evaluateJobIf(job.if, ctx(false, "")), false);
  assert.equal(evaluateJobIf(job.if, ctx(false, "true", "failure")), false);
  assert.equal(job.needs, "act");
});

test("upload.if is the plan's gate string, verbatim", () => {
  assert.equal(publish.jobs.upload.if, UPLOAD_GATE);
});

test("upload gate truth table, evaluated on the literal YAML string", () => {
  const job = publish.jobs.upload;
  const needs = job.needs;
  for (const n of ["validate", "build", "smoke", "generated-tests"]) {
    assert.ok(needs.includes(n), `upload needs ${n}`);
  }
  const rows = [
    ["all green", {}, false, true],
    ["override + generated-tests failure", { "generated-tests": "failure" }, true, true],
    // generate failing fails generated-tests at its first step.
    ["override + generate failure", { "generated-tests": "failure" }, true, true],
    ["override + smoke failure", { smoke: "failure", "generated-tests": "failure" }, true, false],
    ["override + smoke failure, tests green", { smoke: "failure" }, true, false],
    ["no override + generated-tests failure", { "generated-tests": "failure" }, false, false],
    ["generated-tests skipped", { "generated-tests": "skipped" }, false, false],
    ["generated-tests cancelled", { "generated-tests": "cancelled" }, false, false],
    ["build cancelled", { build: "cancelled", smoke: "skipped", "generated-tests": "skipped" }, false, false],
    ["validate failure", { validate: "failure", build: "skipped", smoke: "skipped", "generated-tests": "skipped" }, false, false],
    ["validate failure, rest green", { validate: "failure" }, false, false],
    ["override + build failure", { build: "failure", smoke: "skipped", "generated-tests": "skipped" }, true, false],
    ["override + validate failure", { validate: "failure", "generated-tests": "failure" }, true, false],
    ["override + generated-tests cancelled", { "generated-tests": "cancelled" }, true, false],
    ["override + generated-tests skipped", { "generated-tests": "skipped" }, true, false],
    ["smoke skipped", { smoke: "skipped" }, false, false],
    ["override + smoke skipped", { smoke: "skipped", "generated-tests": "failure" }, true, false],
    ["smoke cancelled", { smoke: "cancelled" }, false, false],
  ];
  for (const [name, results, override, expected] of rows) {
    const ctx = gateContext(needs, { results, override });
    assert.equal(evaluateJobIf(job.if, ctx), expected, name);
  }
  // Repo and ref guards: a fork or a non-main ref never uploads.
  assert.equal(evaluateJobIf(job.if, gateContext(needs, { repository: "laxmareddyp/shared-workflows" })), false);
  assert.equal(evaluateJobIf(job.if, gateContext(needs, { ref: "refs/heads/feature" })), false);
  assert.equal(evaluateJobIf(job.if, gateContext(needs, { ref: "refs/tags/main" })), false);
});

test("generated-tests runs after a successful build even when generate failed, and fails first", () => {
  const job = publish.jobs["generated-tests"];
  assert.equal(job.if, GENERATED_TESTS_IF);
  const ctx = (build, generate) => ({
    needs: { resolve: { result: "success" }, build: { result: build }, generate: { result: generate } },
  });
  assert.equal(evaluateJobIf(job.if, ctx("success", "failure")), true);
  assert.equal(evaluateJobIf(job.if, ctx("success", "success")), true);
  assert.equal(evaluateJobIf(job.if, ctx("failure", "success")), false);
  const first = job.steps[0];
  assert.equal(first.env.GENERATE_RESULT, "${{ needs.generate.result }}");
  assert.match(first.run, /\[ "\$GENERATE_RESULT" != "success" \]/);
  assert.match(first.run, /exit 1/);
  assert.ok(job.needs.includes("generate") && job.needs.includes("build"));
});

// ----------------------------------------------------- step hygiene ---

test("no ${{ inputs.* }} or ${{ github.event.* }} inside run: or script:", () => {
  const bad = /\$\{\{[^}]*\b(inputs\.|github\.event\.)/;
  for (const { id, step } of allSteps()) {
    if (typeof step.run === "string") assert.doesNotMatch(step.run, bad, `${id} run: ${step.name}`);
    const script = (step.with || {}).script;
    if (typeof script === "string") assert.doesNotMatch(script, bad, `${id} script: ${step.name}`);
  }
});

test("no ${{ }} expression of any kind inside run: or script: in the release workflows", () => {
  for (const { id, step } of allSteps(RELEASE_WORKFLOWS)) {
    for (const body of [step.run, (step.with || {}).script]) {
      if (typeof body === "string") assert.ok(!body.includes("${{"), `${id}: ${step.name}`);
    }
  }
});

test("persist-credentials: false on every checkout", () => {
  const checkouts = allSteps().filter(({ step }) => action(step) === CHECKOUT);
  assert.ok(checkouts.length >= 10);
  for (const { id, step } of checkouts) {
    assert.equal((step.with || {})["persist-credentials"], "false", `${id}: ${step.name}`);
  }
});

test("act has no job-level concurrency", () => {
  assert.equal(release.jobs.act.concurrency, undefined);
  for (const { id, job } of allJobs(RELEASE_WORKFLOWS)) {
    assert.equal(job.concurrency, undefined, id);
  }
});

test("no cache restore in privileged jobs", () => {
  for (const id of Object.keys(PRIVILEGED)) {
    const [file, name] = id.split("/");
    for (const step of ALL_WORKFLOWS[file].jobs[name].steps) {
      const a = action(step) || "";
      assert.ok(!a.startsWith("actions/cache"), `${id} uses ${a}`);
      if (/^actions\/setup-/.test(a)) {
        const w = step.with || {};
        assert.equal(w.cache, undefined, `${id} ${a} cache:`);
        assert.equal(w["cache-dependency-path"], undefined, `${id} ${a} cache-dependency-path:`);
      }
    }
  }
});

test("act and dispatch refuse re-runs in their first step", () => {
  for (const name of ["act", "dispatch"]) {
    const first = release.jobs[name].steps[0];
    assert.equal(first.if, undefined, `${name} guard must always run`);
    assert.match(first.run, /if \[ "\$GITHUB_RUN_ATTEMPT" != "1" \]; then/);
    assert.match(first.run, /exit 1/);
  }
});

test("scripts are entered through require() with inputs from env", () => {
  const cases = [
    [release.jobs.plan, "plan", "./scripts/release/plan.js"],
    [release.jobs.act, "act", "./scripts/release/act.js"],
    [publish.jobs.validate, "validate", "./scripts/release/validate_publish.js"],
  ];
  for (const [job, id, file] of cases) {
    const step = job.steps.find((s) => s.id === id);
    assert.ok(step, id);
    assert.ok(step.with.script.includes(`require('${file}')`), `${id} requires ${file}`);
  }
  const dispatchStep = release.jobs.dispatch.steps.find((s) => (s.with || {}).script);
  assert.ok(dispatchStep.with.script.includes("require('./scripts/release/dispatch.js')"));
  assert.equal(dispatchStep.with["github-token"], "${{ steps.app-token.outputs.token }}");
  assert.equal(release.jobs.act.steps.find((s) => s.id === "act").with["github-token"], "${{ steps.app-token.outputs.token }}");
  // Inputs are wired once, at workflow level, through env.
  for (const [name] of RELEASE_INPUTS) {
    assert.ok(Object.values(release.env).includes(`\${{ inputs.${name} }}`), `release env carries ${name}`);
  }
});

test("dispatch passes the tag and the triggering actor through env", () => {
  const step = release.jobs.dispatch.steps.find((s) => (s.with || {}).script);
  assert.equal(step.env.RELEASE_TAG, "${{ needs.act.outputs.tag }}");
  assert.equal(step.env.RELEASE_TRIGGERING_ACTOR, "${{ github.triggering_actor }}");
});

test("generate checks out shared-workflows without a repository override", () => {
  const job = publish.jobs.generate;
  const checkouts = job.steps.filter((s) => action(s) === CHECKOUT);
  const sw = checkouts.find((s) => s.with.path === "sw");
  assert.ok(sw);
  assert.equal(sw.with.repository, undefined);
  assert.equal(sw.with.ref, undefined);
  const target = checkouts.find((s) => s.with.path === "target");
  assert.equal(target.with["fetch-depth"], "0");
  assert.equal(target.with["fetch-tags"], "true");
  assert.equal(target.with.ref, "${{ needs.validate.outputs.sha }}");
});

test("build runs target code without secrets and records digests", () => {
  const job = publish.jobs.build;
  assert.equal(envName(job), null);
  const checkout = job.steps.find((s) => action(s) === CHECKOUT);
  assert.equal(checkout.with.ref, "${{ needs.validate.outputs.sha }}");
  assert.equal(checkout.with["fetch-depth"], "1");
  const names = job.steps.map((s) => s.name);
  assert.ok(names.indexOf("Build setup") < names.indexOf("Build"));
  assert.ok(names.indexOf("Build") < names.findIndex((n) => n.startsWith("Record sha256")));
  assert.equal(job.outputs.digests, "${{ steps.digests.outputs.digests }}");
});

test("smoke and generated-tests: no checkout, one pip command for all wheels, no dist overwrite", () => {
  for (const name of ["smoke", "generated-tests"]) {
    const job = publish.jobs[name];
    assert.ok(!job.steps.some((s) => action(s) === CHECKOUT), `${name} has no checkout`);
    const install = job.steps.filter((s) => typeof s.run === "string" && s.run.includes('"${wheels[@]}"'));
    assert.equal(install.length, 1, name);
    assert.equal(install[0].run.split('"${wheels[@]}"').length, 2, `${name}: one pip command installs every wheel`);
    assert.equal(job.strategy.matrix.backend, "${{ fromJSON(needs.resolve.outputs.backends) }}");
  }
  const smokeRun = publish.jobs.smoke.steps.find((s) => (s.run || "").includes("site-packages")).run;
  assert.match(smokeRun, /"site-packages" not in path/);
  const distUploads = allSteps({ "publish.yml": publish }).filter(
    ({ step }) => action(step) === "actions/upload-artifact" && step.with.name === "dist",
  );
  assert.deepEqual(distUploads.map((s) => s.name), ["build"]);
});

test("upload: sha256 recheck, then validator, then split, then keras-hub first with skip-existing", () => {
  const job = publish.jobs.upload;
  const idx = (pred, label) => {
    const i = job.steps.findIndex(pred);
    assert.ok(i >= 0, label);
    return i;
  };
  const digests = idx((s) => (s.run || "").includes("validate_dist.py digests"), "digest recheck");
  const meta = idx((s) => (s.run || "").includes("validate_dist.py metadata"), "validator");
  const split = idx((s) => (s.run || "").includes("split_existing.py"), "split");
  const pypa = job.steps
    .map((s, i) => [s, i])
    .filter(([s]) => action(s) === "pypa/gh-action-pypi-publish");
  assert.equal(pypa.length, 2);
  assert.ok(digests < meta && meta < split && split < pypa[0][1] && pypa[0][1] < pypa[1][1]);
  assert.equal(pypa[0][0].with["packages-dir"], "${{ steps.split.outputs.upload_dir_0 }}");
  assert.equal(pypa[1][0].with["packages-dir"], "${{ steps.split.outputs.upload_dir_1 }}");
  for (const [s] of pypa) assert.equal(s.with["skip-existing"], "true");
  assert.ok(job.steps[meta].run.includes('--tag "$PUBLISH_TAG"'), "Version is checked against the tag");
  assert.equal(job.steps[digests].env.DIGESTS, "${{ needs.build.outputs.digests }}");
});

test("post-publish digest-checks with the upload manifest", () => {
  const step = publish.jobs["post-publish"].steps.find((s) => (s.run || "").includes("post_publish.py"));
  assert.equal(step.env.MANIFEST, "${{ needs.upload.outputs.manifest }}");
  assert.equal(step.env.DIGESTS, "${{ needs.build.outputs.digests }}");
  assert.ok(publish.jobs["post-publish"].needs.includes("upload"));
});

test("report jobs always run and hold no secrets", () => {
  for (const wf of Object.values(RELEASE_WORKFLOWS)) {
    assert.equal(wf.jobs.report.if, "always()");
    assert.equal(envName(wf.jobs.report), null);
  }
});

test("test.yml keeps unit-tests unchanged and adds pytest and zizmor", () => {
  assert.deepEqual(Object.keys(tests.jobs), ["unit-tests", "pytest", "zizmor"]);
  assert.deepEqual(tests.jobs["unit-tests"], {
    "runs-on": "ubuntu-latest",
    steps: [
      {
        name: "Check out repository",
        uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        with: { "persist-credentials": "false" },
      },
      { name: "Run unit tests", run: "node --test 'scripts/**/*.test.js'" },
    ],
  });
  assert.ok(tests.jobs.pytest.steps.some((s) => (s.run || "").includes("pytest -q scripts/release/py")));
  assert.ok(tests.jobs.zizmor.steps.some((s) => (s.run || "").startsWith("zizmor ")));
});
