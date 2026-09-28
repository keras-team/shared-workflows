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
 * Static no-merge / no-direct-push test (plan section 7).
 *
 * Scans every non-test `.js` file under scripts/release/, plus the run: and
 * script: bodies of release.yml / publish.yml / test.yml, and fails on:
 *   - any merge API: `pulls.merge`, `repos.merge`, `POST /merges`,
 *     `PUT .../pulls/{n}/merge` (also concatenated), GraphQL
 *     `mergePullRequest` / `enablePullRequestAutoMerge` / `mergeBranch` /
 *     `enqueuePullRequest`, `mergeUpstream`, a bare `merge` identifier,
 *     `gh pr merge`;
 *   - any git push whose refspec is not an inline literal under
 *     `release-tool/` (or `refs/heads/release-tool/`), `--tags` / `--all` /
 *     `--mirror` / `--delete` pushes, and shell-string `git push`;
 *   - creating a ref other than an inline `refs/heads/...` literal, and
 *     updating or deleting a ref outside `release-tool/` (branch creation via
 *     `createRef` stays allowed: it is how the bot cuts B at `commit_sha`).
 *
 * The scanner tokenizes JS (strings, templates, comments, regex literals), so
 * comments that mention a merge API do not trip it and a merge call split
 * across tokens still does.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "case", "in", "of", "delete", "void", "throw", "new",
  "else", "do", "yield", "await",
]);

function readQuoted(src, i) {
  const q = src[i];
  let j = i + 1;
  let value = "";
  while (j < src.length && src[j] !== q) {
    if (src[j] === "\\") {
      value += src[j + 1];
      j += 2;
      continue;
    }
    if (src[j] === "\n") throw new Error(`unterminated string at ${i}`);
    value += src[j];
    j += 1;
  }
  if (j >= src.length) throw new Error(`unterminated string at ${i}`);
  return { value, end: j + 1 };
}

// Skips a JS expression inside `${ ... }` starting at i; returns index after `}`.
function skipTemplateExpr(src, i) {
  let depth = 1;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "'" || c === '"') {
      j = readQuoted(src, j).end;
      continue;
    }
    if (c === "`") {
      j = readTemplate(src, j).end;
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  throw new Error(`unterminated template expression at ${i}`);
}

function readTemplate(src, i) {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") return { value: src.slice(i + 1, j), end: j + 1 };
    if (c === "$" && src[j + 1] === "{") {
      j = skipTemplateExpr(src, j + 2);
      continue;
    }
    j += 1;
  }
  throw new Error(`unterminated template at ${i}`);
}

function readRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "\n") throw new Error(`unterminated regex at ${i}`);
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      j += 1;
      while (/[a-z]/i.test(src[j] || "")) j += 1;
      return j;
    }
    j += 1;
  }
  throw new Error(`unterminated regex at ${i}`);
}

/**
 * Tokens: { type: "str"|"tpl"|"ident"|"num"|"punct"|"regex", value,
 *           parent (index of the enclosing opener token or -1),
 *           close (for openers: index of the matching closer) }.
 */
function tokenize(src) {
  const tokens = [];
  const stack = [];
  let i = 0;
  const push = (tok) => {
    tok.parent = stack.length ? stack[stack.length - 1] : -1;
    tokens.push(tok);
    return tokens.length - 1;
  };
  const last = () => tokens[tokens.length - 1];
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated comment");
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const { value, end } = readQuoted(src, i);
      push({ type: "str", value });
      i = end;
      continue;
    }
    if (c === "`") {
      const { value, end } = readTemplate(src, i);
      push({ type: "tpl", value });
      i = end;
      continue;
    }
    if (c === "/") {
      const prev = last();
      const regexOk = !prev
        || (prev.type === "punct" && REGEX_PRECEDERS.has(prev.value))
        || (prev.type === "ident" && REGEX_KEYWORDS.has(prev.value));
      if (regexOk) {
        const end = readRegex(src, i);
        push({ type: "regex", value: src.slice(i, end) });
        i = end;
        continue;
      }
    }
    const ident = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i, i + 200));
    if (ident) {
      push({ type: "ident", value: ident[0] });
      i += ident[0].length;
      continue;
    }
    const num = /^[0-9][0-9a-fA-FxX._n]*/.exec(src.slice(i, i + 50));
    if (num) {
      push({ type: "num", value: num[0] });
      i += num[0].length;
      continue;
    }
    if (src.startsWith("...", i)) {
      push({ type: "punct", value: "..." });
      i += 3;
      continue;
    }
    if ("([{".includes(c)) {
      stack.push(push({ type: "punct", value: c }));
      i += 1;
      continue;
    }
    if (")]}".includes(c)) {
      const open = stack.pop();
      if (open === undefined) throw new Error(`unbalanced ${c} at ${i}`);
      const idx = push({ type: "punct", value: c });
      tokens[open].close = idx;
      i += 1;
      continue;
    }
    push({ type: "punct", value: c });
    i += 1;
  }
  if (stack.length) throw new Error("unbalanced brackets at end of file");
  return tokens;
}

const MERGE_PATTERNS = [
  [/\bpulls\s*\.\s*merge\b/, "pulls.merge"],
  [/\brepos\s*\.\s*merge\b/, "repos.merge"],
  [/\b(pulls|repos)\s*\[\s*"merge"\s*\]/, "merge via bracket access"],
  [/\/merges\b/, "POST /merges"],
  [/\/pulls\/\S*\/merge\b/, "PUT /pulls/{n}/merge"],
  [/mergePullRequest/, "GraphQL mergePullRequest"],
  [/enablePullRequestAutoMerge/, "GraphQL enablePullRequestAutoMerge"],
  [/\bgh\s+pr\s+merge\b/, "gh pr merge"],
  [/"pr"\s*,\s*"merge"/, "gh pr merge (argument array)"],
  [/\bmergeUpstream\b|merge-upstream/, "merge upstream (sync fork)"],
  [/\bmergeBranch\b/, "GraphQL mergeBranch"],
  [/\benqueuePullRequest\b/, "GraphQL merge-queue enqueue"],
];

const FORBIDDEN_PUSH_FLAGS = /^(--tags|--all|--mirror|--delete|-d|--prune|--follow-tags)(=|$)/;
const RELEASE_TOOL_DEST = /^(refs\/heads\/)?release-tool\//;

function isLiteral(tok) {
  return tok.type === "str" || tok.type === "tpl";
}

function elementsOf(tokens, openIdx, startIdx) {
  const elements = [];
  let cur = [];
  for (let k = startIdx; k < tokens[openIdx].close; k += 1) {
    const tok = tokens[k];
    if (tok.type === "punct" && tok.value === "," && tok.parent === openIdx) {
      if (cur.length) elements.push(cur);
      cur = [];
      continue;
    }
    cur.push(tok);
  }
  if (cur.length) elements.push(cur);
  return elements;
}

function checkPushArray(tokens, pushIdx, violations) {
  const openIdx = tokens[pushIdx].parent;
  const opener = openIdx >= 0 ? tokens[openIdx] : null;
  if (!opener || opener.value !== "[") {
    violations.push('string "push" outside a git argument array (cannot verify the refspec)');
    return;
  }
  const elements = elementsOf(tokens, openIdx, pushIdx + 1);
  const positional = [];
  for (const el of elements) {
    if (el.length === 1 && isLiteral(el[0]) && el[0].value.startsWith("-")) {
      if (FORBIDDEN_PUSH_FLAGS.test(el[0].value)) {
        violations.push(`git push with forbidden flag ${el[0].value}`);
      }
      continue;
    }
    positional.push(el);
  }
  // Tokens before "push" (e.g. ["-c", "x=y", "push", ...]) are git options
  // and are not inspected.
  if (positional.length < 2) {
    violations.push("git push without an explicit release-tool/ refspec");
    return;
  }
  for (const el of positional.slice(1)) {
    if (el.length !== 1 || !isLiteral(el[0])) {
      violations.push("git push refspec is not an inline string literal (cannot verify it targets release-tool/)");
      continue;
    }
    const spec = el[0].value;
    const dest = spec.slice(spec.lastIndexOf(":") + 1).replace(/^\+/, "");
    if (!RELEASE_TOOL_DEST.test(dest)) {
      violations.push(`git push to ${JSON.stringify(spec)} (only release-tool/* may be pushed)`);
    }
  }
}

function callArgs(tokens, calleeIdx) {
  const open = tokens[calleeIdx + 1];
  if (!open || open.value !== "(") return null;
  return tokens.slice(calleeIdx + 2, open.close);
}

function checkRefCalls(tokens, violations) {
  tokens.forEach((tok, idx) => {
    if (tok.type !== "ident" && !isLiteral(tok)) return;
    let kind = null;
    let args = null;
    if (tok.type === "ident" && ["createRef", "updateRef", "deleteRef"].includes(tok.value)) {
      kind = tok.value === "createRef" ? "create" : "change";
      args = callArgs(tokens, idx);
    } else if (isLiteral(tok) && /\/git\/refs\b/.test(tok.value)) {
      const method = tok.value.trim().split(/\s+/)[0].toUpperCase();
      if (method === "POST") kind = "create";
      else if (method === "PATCH" || method === "DELETE") kind = "change";
      const parent = tok.parent >= 0 ? tokens[tok.parent] : null;
      if (parent && parent.value === "(") args = tokens.slice(tok.parent + 1, parent.close);
    }
    if (!kind || !args) return;
    const literals = args.filter(isLiteral).map((t) => t.value);
    if (kind === "create" && literals.some((v) => /(^|\/)tags\//.test(v) && !/\/git\/refs\b/.test(v))) {
      violations.push("tag ref created through the git refs API (tags come only from POST /releases)");
    }
    if (kind === "create") {
      const at = args.findIndex((t, k) => t.type === "ident" && t.value === "ref"
        && args[k + 1] && args[k + 1].value === ":");
      const value = at >= 0 ? args[at + 2] : null;
      if (!value || !isLiteral(value) || !value.value.startsWith("refs/heads/")) {
        violations.push("ref created without an inline `ref: \"refs/heads/...\"` literal");
      }
    }
    if (kind === "change" && !literals.some((v) => v.includes("release-tool/"))) {
      violations.push("ref updated or deleted outside release-tool/");
    }
  });
}

function scanSource(src) {
  const violations = [];
  const tokens = tokenize(src);
  const flat = tokens
    .filter((t) => t.type !== "regex")
    .map((t) => (isLiteral(t) ? JSON.stringify(t.value) : t.value))
    .join(" ");
  for (const [re, label] of MERGE_PATTERNS) {
    if (re.test(flat)) violations.push(`merge API: ${label}`);
  }
  tokens.forEach((tok, idx) => {
    if (tok.type === "ident" && tok.value === "merge") {
      violations.push("identifier `merge` (e.g. destructured from pulls/repos)");
    }
    if (!isLiteral(tok)) return;
    if (/\/merges?\/?$/.test(tok.value)) violations.push("literal ending in /merge or /merges");
    if (/\bgit\s+push\b/.test(tok.value)) violations.push("shell-string git push");
    if (tok.value === "push") checkPushArray(tokens, idx, violations);
  });
  checkRefCalls(tokens, violations);
  return violations;
}

function releaseSources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...releaseSources(full));
    else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")
      && entry.name !== "test_support.js") out.push(full);
  }
  return out.sort();
}

test("scanner flags every forbidden merge and push form", () => {
  const bad = {
    "pulls.merge": "await github.rest.pulls.merge({ owner, repo, pull_number: 1 });",
    "pulls.merge split": "await github.rest.pulls\n  .merge({});",
    "repos.merge": "await github.rest.repos.merge({ owner, repo, base, head });",
    "bracket": 'await github.rest.pulls["merge"]({});',
    "POST /merges": 'await github.request("POST /repos/{owner}/{repo}/merges", {});',
    "PUT pull merge": 'await github.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge");',
    "graphql merge": 'await github.graphql("mutation { mergePullRequest(input: {}) { clientMutationId } }");',
    "graphql auto-merge": "await github.graphql(`mutation { enablePullRequestAutoMerge(input: {}) { x } }`);",
    "gh shell": 'execSync("gh pr merge 12 --squash");',
    "gh args": 'execFileSync("gh", ["pr", "merge", "12"]);',
    "push to release branch": 'git(["push", "origin", "HEAD:refs/heads/r0.33"]);',
    "push short branch": 'git(["push", "origin", "r0.33"]);',
    "push tags": 'git(["push", "--tags", "origin", "release-tool/x"]);',
    "push variable refspec": "git([\"push\", remote, refspec]);",
    "push spread": 'git(["push", remote, ...specs]);',
    "push no refspec": 'git(["push", "origin"]);',
    "push outside array": 'const verb = "push"; git([verb, "origin", "release-tool/x"]);',
    "shell push": 'execSync("git push origin main");',
    "tag createRef": "await github.rest.git.createRef({ owner, repo, ref: `refs/tags/v${v}`, sha });",
    "tag via request": 'await github.request("POST /repos/{owner}/{repo}/git/refs", { ref: "refs/tags/v1.0.0", sha });',
    "updateRef release branch": 'await github.rest.git.updateRef({ owner, repo, ref: "heads/r0.33", sha, force: true });',
    "deleteRef": "await github.rest.git.deleteRef({ owner, repo, ref: `heads/${b}` });",
    "mergeUpstream": "await github.rest.repos.mergeUpstream({ owner, repo, branch });",
    "merge-upstream URL": 'await github.request("POST /repos/{owner}/{repo}/merge-upstream", {});',
    "graphql mergeBranch": 'await github.graphql("mutation { mergeBranch(input: {}) { x } }");',
    "graphql merge queue": 'await github.graphql("mutation { enqueuePullRequest(input: {}) { x } }");',
    "concatenated merge URL": 'await github.request("PUT /repos/o/r/pulls/" + n + "/merge");',
    "destructured merge": "const { merge } = github.rest.pulls; await merge({});",
    "createRef variable ref": "await github.rest.git.createRef({ owner, repo, ref: someVar, sha });",
  };
  for (const [name, src] of Object.entries(bad)) {
    assert.ok(scanSource(src).length > 0, `expected a violation for: ${name}`);
  }
});

test("scanner allows the bot's legitimate operations", () => {
  const good = [
    "git([\"push\", \"--force\", remote, `${sha}:refs/heads/release-tool/bump-${v}`]);",
    'git(["-c", "core.hooksPath=/dev/null", "push", "origin", "+HEAD:release-tool/master-bump-1.0.0"]);',
    "await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha });",
    "await github.rest.git.updateRef({ owner, repo, ref: `heads/release-tool/bump-${v}`, sha, force: true });",
    'const args = []; args.push("x"); picks.push({ sha });',
    "// The bot never calls pulls.merge or gh pr merge.\nconst x = 1;",
    "/* git push origin main */ const y = 2;",
    'const re = /[\\]]"push"/; git(["push", "origin", "HEAD:refs/heads/release-tool/x"]);',
    'await github.rest.pulls.create({ title: "Merge fixes into r0.33", head, base });',
    'await github.rest.pulls.list({ state: "closed" }); const merged = pr.merged;',
    "await github.rest.repos.createRelease({ tag_name: `v${v}`, target_commitish: sha, draft: false });",
  ];
  for (const src of good) {
    assert.deepEqual(scanSource(src), [], `unexpected violation for: ${src}`);
  }
});

test("release scripts never merge and push only to release-tool/*", () => {
  const dir = __dirname;
  const files = releaseSources(dir);
  const rel = files.map((f) => path.relative(dir, f));
  // Guard against a vacuous pass: the modules that talk to GitHub and git
  // must be among the scanned files.
  for (const required of ["lib/gh.js", "lib/git.js", "act.js"]) {
    assert.ok(rel.includes(required), `${required} was not scanned; found ${rel.join(", ")}`);
  }
  const report = [];
  for (const file of files) {
    for (const v of scanSource(fs.readFileSync(file, "utf8"))) {
      report.push(`${path.relative(dir, file)}: ${v}`);
    }
  }
  assert.deepEqual(report, []);
});

test("only test files load test_support.js, so excluding it from the scan hides nothing", () => {
  const offenders = releaseSources(__dirname)
    .filter((f) => /require\(\s*["'][./]*test_support(\.js)?["']\s*\)/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(__dirname, f));
  assert.deepEqual(offenders, []);
});

test("workflow run: and script: bodies never merge or push", () => {
  const yaml = require("./yaml_lite.js");
  const root = path.join(__dirname, "..", "..");
  const report = [];
  let scanned = 0;
  for (const file of ["release.yml", "publish.yml", "test.yml"]) {
    const wf = yaml.parseFile(path.join(root, ".github", "workflows", file));
    for (const [name, job] of Object.entries(wf.jobs)) {
      (job.steps || []).forEach((step, i) => {
        const where = `${file}/${name}/steps[${i}]`;
        if (typeof step.run === "string") {
          scanned += 1;
          for (const [re, label] of MERGE_PATTERNS) {
            if (re.test(step.run)) report.push(`${where}: merge API: ${label}`);
          }
          if (/\bgit\s+push\b/.test(step.run)) report.push(`${where}: git push in run:`);
        }
        const script = (step.with || {}).script;
        if (typeof script === "string") {
          scanned += 1;
          for (const v of scanSource(script)) report.push(`${where}: ${v}`);
        }
      });
    }
  }
  assert.ok(scanned >= 10, `only ${scanned} run:/script: bodies were scanned`);
  assert.deepEqual(report, []);
});

module.exports = { scanSource, tokenize };
