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
 * Markdown run-summary rendering.
 *
 * Every summary's first line names the version and the step (plus any
 * warning, e.g. "released on GitHub but not on PyPI"), and its last line
 * starts with "Next:". Anything that came from the target repo (PR titles,
 * commit subjects, file names) goes through `escapeMd`.
 */

const { RefusalError } = require("./errors");

const MD_SPECIAL = /[\\`*_{}[\]()<>#+\-.!|~@]/g;

function escapeMd(text) {
  return String(text == null ? "" : text)
    .replace(/[\r\n]+/g, " ")
    .replace(MD_SPECIAL, "\\$&");
}

function table(headers, rows) {
  const out = [`| ${headers.join(" | ")} |`, `|${headers.map(() => " --- |").join("")}`];
  for (const row of rows) out.push(`| ${row.join(" | ")} |`);
  return out.join("\n");
}

class Report {
  constructor(title = "Release") {
    this.title = title;
    this.version = null;
    this.step = null;
    this.warnings = [];
    this.body = [];
    this.next = null;
    this.failed = false;
  }

  setHeader(version, step) {
    if (version) this.version = version;
    if (step) this.step = step;
  }

  warn(text) {
    this.warnings.push(text);
  }

  /** Raw markdown; callers escape untrusted parts themselves. */
  add(markdown) {
    this.body.push(markdown);
  }

  setNext(text) {
    this.next = text;
  }

  refuse(err) {
    this.failed = true;
    const isRefusal = err instanceof RefusalError;
    this.add(`**Refused:** ${err.message}`);
    this.setNext(isRefusal && err.next ? err.next :
      "fix the error above, then click Run workflow again (a new run, " +
      "not Re-run).");
  }

  /** Version is PEP 440-validated and step is a fixed enum: not escaped. */
  firstLine() {
    const head = `**${this.title} ${this.version || "(version not resolved)"}` +
      ` — step: ${this.step || "none"}**`;
    const warnings = this.warnings.map((w) => ` · ⚠️ **${escapeMd(w)}**`);
    return head + warnings.join("");
  }

  toMarkdown() {
    const next = this.next || "nothing to do.";
    return [this.firstLine(), "", ...this.body, "", `Next: ${next}`].join("\n");
  }
}

async function writeSummary(core, report) {
  const md = report.toMarkdown();
  core.info(md);
  await core.summary.addRaw(md, true).write();
  return md;
}

function branchesSection(rows) {
  if (rows.length === 0) return "### Release branches\n\nNone found.";
  return "### Release branches\n\n" + table(
    ["Branch", "Latest release", "Next stable", "Next dev"],
    rows.map((r) => [r.branch, r.latest || "—", r.nextStable || "—",
      r.nextDev || "—"].map(escapeMd)),
  );
}

function candidatesSection(branch, result) {
  const head = `### Cherry-pick candidates for ${escapeMd(branch)}`;
  if (!result) return `${head}\n\nBranch does not exist yet; picks are refused ` +
    "for a new branch (it is cut from `commit_sha`).";
  const open = result.candidates.filter((c) => !c.picked);
  const rows = open.map((c) => [
    c.number === null ? "—" : `#${c.number}`,
    escapeMd(c.sha.slice(0, 7)),
    escapeMd(c.title),
    c.hint ? "maybe (cherry-pick trailer found)" : "",
  ]);
  const picked = result.candidates.filter((c) => c.picked)
    .map((c) => `#${c.number}`);
  const parts = [head, "",
    rows.length ? table(["PR", "Commit", "Title", "Already on branch?"], rows) :
      "No master PRs missing from this branch."];
  if (picked.length) parts.push("", `Already picked (Cherry-picks: lines): ${picked.join(", ")}`);
  if (result.truncated) parts.push("", "List truncated to the first 250 commits.");
  return parts.join("\n");
}

function formSection(values) {
  return "### Form values for the real run\n\n" + table(
    ["Field", "Value"],
    Object.entries(values).map(([k, v]) => [escapeMd(k),
      v === "" ? "(blank)" : `\`${String(v).replaceAll("`", "")}\``]),
  );
}

function listSection(title, items) {
  if (items.length === 0) return `### ${title}\n\nNone.`;
  return `### ${title}\n\n` + items.map((i) => `- ${i}`).join("\n");
}

module.exports = {
  Report,
  candidatesSection,
  branchesSection,
  escapeMd,
  formSection,
  listSection,
  table,
  writeSummary,
};
