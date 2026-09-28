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
const S = require("./summary");
const { RefusalError } = require("./errors");

describe("escapeMd", () => {
  it("neutralises markdown, links, html, mentions and newlines", () => {
    const out = S.escapeMd("[x](http://e) <img> *b* _i_ `c` @team #1\nline|2");
    for (const raw of ["[x]", "<img>", "*b*", "_i_", "`c`", "\n"]) {
      assert.ok(!out.includes(raw), raw);
    }
    assert.ok(out.includes("\\(http") && out.includes("\\@team"));
    assert.equal(S.escapeMd("a*b"), "a\\*b");
    assert.equal(S.escapeMd(null), "");
  });
});

describe("Report", () => {
  it("first line names version and step; last line starts with Next:", () => {
    const r = new S.Report();
    r.setHeader("0.33.1", "fast-path");
    r.add("body");
    r.setNext("watch the publish run.");
    const lines = r.toMarkdown().split("\n");
    assert.equal(lines[0], "**Release 0.33.1 — step: fast-path**");
    assert.equal(lines.at(-1), "Next: watch the publish run.");
  });

  it("puts warnings on the first line", () => {
    const r = new S.Report();
    r.setHeader("0.33.2", "prepare");
    r.warn("v0.33.1 is released on GitHub but not on PyPI; run with version=0.33.1 to re-publish");
    const first = r.toMarkdown().split("\n")[0];
    assert.match(first, /0\.33\.2 — step: prepare/);
    assert.match(first, /not on PyPI/);
  });

  it("renders a refusal with its Next text exactly once", () => {
    const r = new S.Report();
    r.refuse(new RefusalError("Nope.", "do the thing."));
    const md = r.toMarkdown();
    assert.ok(md.includes("**Refused:** Nope."));
    assert.equal(md.split("\n").at(-1), "Next: do the thing.");
    assert.equal(md.match(/Next:/g).length, 1);
    assert.equal(r.failed, true);
  });

  it("gives unexpected errors a generic Next", () => {
    const r = new S.Report();
    r.refuse(new Error("boom"));
    assert.match(r.toMarkdown().split("\n").at(-1), /^Next: .*new run/);
  });
});

describe("discovery sections", () => {
  it("escapes candidate titles and lists already-picked PRs separately", () => {
    const md = S.candidatesSection("r0.33", {
      candidates: [
        { number: 5, sha: "a".repeat(40), title: "Fix [link](x)", picked: false, hint: false },
        { number: 6, sha: "b".repeat(40), title: "Old", picked: true, hint: false },
      ],
      truncated: false,
    });
    assert.ok(md.includes(S.escapeMd("Fix [link](x)")));
    assert.ok(!md.includes("[link](x)"));
    assert.match(md, /Already picked.*#6/);
    assert.ok(!md.includes("| #6 |"));
  });

  it("explains a missing branch and renders form values", () => {
    assert.match(S.candidatesSection("r0.99", null), /does not exist/);
    const form = S.formSection({ version: "", dry_run: "false" });
    assert.match(form, /\| version \| \(blank\) \|/);
    assert.match(form, /\| dry\\_run \| `false` \|/);
  });

  it("renders release branches with next versions", () => {
    const md = S.branchesSection([
      { branch: "r0.33", latest: "0.33.0", nextStable: "0.33.1", nextDev: "0.33.1.dev0" },
    ]);
    assert.match(md, /r0\\\.33 \| 0\\\.33\\\.0 \| 0\\\.33\\\.1 \| 0\\\.33\\\.1\\\.dev0/);
  });
});
