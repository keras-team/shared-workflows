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
 * The only module that talks to GitHub for target-repo data.
 *
 * Wraps the octokit that actions/github-script provides (`github.rest.*`,
 * `github.paginate`). There is deliberately no merge call anywhere in here:
 * the bot opens PRs, humans merge them.
 */

const { RefusalError } = require("./errors");
const { readVersionFromFile } = require("./version");
const { parseCherryPicksLines } = require("./picks");
const { hasWrite } = require("./guards");
const { ACTIVE_STATUSES } = require("./lock");
const { ABANDONED_LABEL } = require("./detect");

const CANDIDATE_PR_LOOKUPS = 30;

const isNotFound = (err) => Boolean(err) && err.status === 404;
const firstLine = (text) => String(text || "").split("\n")[0];

/** Versions of `pkg` on PyPI: Set, empty Set on 404, null if lookup failed. */
async function pypiVersions(pkg, fetchImpl) {
  try {
    const url = `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`;
    const res = await fetchImpl(url);
    if (res.status === 404) return new Set();
    if (!res.ok) return null;
    const data = await res.json();
    return new Set(Object.keys(data.releases || {}));
  } catch (err) {
    return null;
  }
}

class Gh {
  constructor({ github, owner, repo }) {
    this.github = github;
    this.rest = github.rest;
    this.base = { owner, repo };
    this.fullName = `${owner}/${repo}`;
  }

  async permission(user) {
    if (!user) return "none";
    try {
      const { data } = await this.rest.repos.getCollaboratorPermissionLevel({
        ...this.base, username: user,
      });
      return data.permission || "none";
    } catch (err) {
      if (isNotFound(err)) return "none";
      throw err;
    }
  }

  async fileAt(ref, path) {
    try {
      const { data } = await this.rest.repos.getContent({
        ...this.base, path, ref,
      });
      if (Array.isArray(data) || data.type !== "file") return null;
      return Buffer.from(data.content, data.encoding || "base64")
        .toString("utf8");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** The version all `files` carry at `ref`; refuses if missing or split. */
  async versionAt(ref, files) {
    const found = [];
    for (const file of files) {
      const text = await this.fileAt(ref, file);
      if (text === null) {
        throw new RefusalError(`Version file ${file} is missing at ${ref}.`,
          "check `version_files` in the repo config.");
      }
      found.push(readVersionFromFile(text));
    }
    if (new Set(found).size !== 1) {
      const pairs = files.map((f, i) => `${f}=${found[i]}`).join(", ");
      throw new RefusalError(`Version files disagree at ${ref}: ${pairs}.`,
        "make every version file carry the same version, then run again.");
    }
    return found[0];
  }

  async branchHead(name) {
    try {
      const { data } = await this.rest.repos.getBranch({
        ...this.base, branch: name,
      });
      return data.commit.sha;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** `{ sha, parents, title }` for a commit-ish, or null if unknown. */
  async commit(ref) {
    try {
      const { data } = await this.rest.repos.getCommit({ ...this.base, ref });
      return {
        sha: data.sha,
        parents: data.parents.map((p) => p.sha),
        title: firstLine(data.commit && data.commit.message),
      };
    } catch (err) {
      if (isNotFound(err) || err.status === 422) return null;
      throw err;
    }
  }

  async compare(base, head) {
    const { data } = await this.rest.repos.compareCommitsWithBasehead({
      ...this.base, basehead: `${base}...${head}`,
    });
    return data;
  }

  /** True when `sha` is an ancestor of (or equal to) `ref`. */
  async isAncestor(sha, ref) {
    try {
      const data = await this.compare(sha, ref);
      return data.status === "ahead" || data.status === "identical";
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /** Commits on `branch` after `sha`, oldest first: `[{ sha, message }]`. */
  async commitsAfter(branch, sha) {
    const data = await this.compare(sha, branch);
    if (data.status !== "ahead" && data.status !== "identical") {
      throw new RefusalError(`Commit ${sha} is not on ${branch}.`,
        `check the history of ${branch}.`);
    }
    return data.commits.map((c) => ({ sha: c.sha, message: c.commit.message }));
  }

  /** First-parent chain of `branch`, newest first, at most `limit` shas. */
  async firstParentShas(branch, limit = 3000) {
    let cur = await this.branchHead(branch);
    const parentsOf = new Map();
    const out = [];
    const pages = this.github.paginate.iterator(this.rest.repos.listCommits, {
      ...this.base, sha: branch, per_page: 100,
    });
    for await (const { data } of pages) {
      for (const c of data) parentsOf.set(c.sha, c.parents.map((p) => p.sha));
      while (cur && parentsOf.has(cur) && out.length < limit) {
        out.push(cur);
        cur = parentsOf.get(cur)[0];
      }
      if (!cur || out.length >= limit) break;
    }
    return out;
  }

  async pull(number) {
    try {
      const { data } = await this.rest.pulls.get({
        ...this.base, pull_number: number,
      });
      return data;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async commitPulls(sha) {
    const { data } = await this.rest.repos
      .listPullRequestsAssociatedWithCommit({ ...this.base, commit_sha: sha });
    return data.map((p) => p.number);
  }

  /** True only if the latest `label` event was made by a user with write. */
  async labelAddedByWriter(prNumber, label) {
    const events = await this.github.paginate(this.rest.issues.listEvents, {
      ...this.base, issue_number: prNumber, per_page: 100,
    });
    const added = events.filter((e) =>
      e.event === "labeled" && e.label && e.label.name === label);
    if (added.length === 0) return false;
    const actor = added[added.length - 1].actor;
    return hasWrite(await this.permission(actor && actor.login));
  }

  /** Follows annotated tag objects down to the commit sha. */
  async derefTagObject(object) {
    let obj = object;
    for (let i = 0; i < 5 && obj.type === "tag"; i++) {
      const { data } = await this.rest.git.getTag({
        ...this.base, tag_sha: obj.sha,
      });
      obj = data.object;
    }
    return obj.type === "commit" ? obj.sha : null;
  }

  async resolveTag(name) {
    try {
      const { data } = await this.rest.git.getRef({
        ...this.base, ref: `tags/${name}`,
      });
      return await this.derefTagObject(data.object);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async listTags(prefix) {
    const refs = await this.github.paginate(this.rest.git.listMatchingRefs, {
      ...this.base, ref: `tags/${prefix}`, per_page: 100,
    });
    const tags = [];
    for (const ref of refs) {
      const sha = await this.derefTagObject(ref.object);
      if (sha) tags.push({ name: ref.ref.replace(/^refs\/tags\//, ""), sha });
    }
    return tags;
  }

  async listReleases() {
    const all = await this.github.paginate(this.rest.repos.listReleases, {
      ...this.base, per_page: 100,
    });
    return all.map((r) => ({
      id: r.id, tag_name: r.tag_name, draft: r.draft,
      prerelease: r.prerelease, target_commitish: r.target_commitish,
      author_login: r.author ? r.author.login : null,
    }));
  }

  async releaseBranches(pattern) {
    const re = new RegExp(pattern);
    const all = await this.github.paginate(this.rest.repos.listBranches, {
      ...this.base, per_page: 100,
    });
    return all.map((b) => b.name).filter((n) => re.test(n));
  }

  listPulls(baseRef, state) {
    return this.github.paginate(this.rest.pulls.list, {
      ...this.base, base: baseRef, state, per_page: 100,
    });
  }

  async toolPr(p) {
    const merged = Boolean(p.merged_at);
    const full = merged ? await this.pull(p.number) : p;
    const labels = (p.labels || []).map((l) => typeof l === "string" ? l : l.name);
    return {
      number: p.number, state: p.state, merged,
      merge_commit_sha: full.merge_commit_sha || null,
      head_ref: p.head.ref,
      head_repo_full_name: p.head.repo ? p.head.repo.full_name : null,
      base_ref: p.base.ref,
      base_repo_full_name: p.base.repo ? p.base.repo.full_name : null,
      author_login: p.user ? p.user.login : null,
      merged_by_login: full.merged_by ? full.merged_by.login : null,
      body: p.body || "",
      labels,
      abandoned_by_writer: labels.includes(ABANDONED_LABEL) &&
        await this.labelAddedByWriter(p.number, ABANDONED_LABEL),
    };
  }

  /** State consumed by the pure modules; see impl_spec "State". */
  async gatherState({ config, branch, fetchPypi }) {
    const files = config.version_files;
    const headSha = await this.branchHead(branch);
    const defaultHead = await this.branchHead(config.default_branch);
    if (!defaultHead) {
      throw new RefusalError(`Default branch ${config.default_branch} not found.`,
        "check `default_branch` in the repo config.");
    }
    const branchPulls = await this.listPulls(branch, "all");
    const defaultOpen = await this.listPulls(config.default_branch, "open");
    const seen = new Set();
    const prs = [];
    for (const p of [...branchPulls, ...defaultOpen]) {
      if (!p.head || !p.head.ref.startsWith("release-tool/")) continue;
      // Only the bot's own branches in the target repo count; anyone can open
      // a fork PR whose head is named release-tool/*.
      if (!p.head.repo || p.head.repo.full_name !== this.fullName) continue;
      if (seen.has(p.number)) continue;
      seen.add(p.number);
      prs.push(await this.toolPr(p));
    }
    const mergedBodies = branchPulls.filter((p) => p.merged_at)
      .map((p) => p.body || "");
    return {
      branch,
      branchExists: headSha !== null,
      headSha,
      versionAtHead: headSha ? await this.versionAt(headSha, files) : null,
      defaultBranchVersion: await this.versionAt(defaultHead, files),
      defaultHeadSha: defaultHead,
      tags: await this.listTags(config.tag_prefix),
      releases: await this.listReleases(),
      prs,
      pickedPrNumbers: parseCherryPicksLines(mergedBodies),
      pypiVersions: fetchPypi ? await fetchPypi(config.packages[0]) : null,
    };
  }

  /**
   * Master PRs not yet on `branch`, oldest first. `picked` marks PRs listed
   * in a merged `Cherry-picks:` line; `hint` marks commits whose sha appears
   * in a `(cherry picked from commit ...)` trailer on the branch.
   */
  async pickCandidates({ branch, defaultBranch, picked }) {
    const missing = await this.compare(branch, defaultBranch);
    const onBranch = await this.compare(defaultBranch, branch);
    const trailers = new Set();
    for (const c of onBranch.commits) {
      const re = /\(cherry picked from commit ([0-9a-f]{40})\)/g;
      for (const m of c.commit.message.matchAll(re)) trailers.add(m[1]);
    }
    const byPr = new Map();
    let lookups = 0;
    for (const c of missing.commits) {
      const title = firstLine(c.commit.message);
      const m = title.match(/\(#(\d+)\)\s*$/) ||
        title.match(/^Merge pull request #(\d+)/);
      let number = m ? Number(m[1]) : null;
      if (number === null && lookups < CANDIDATE_PR_LOOKUPS) {
        lookups += 1;
        number = (await this.commitPulls(c.sha))[0] || null;
      }
      const key = number === null ? c.sha : number;
      if (byPr.has(key) && !m) continue;
      byPr.set(key, {
        number, sha: c.sha, title,
        picked: number !== null && picked.has(number),
        hint: trailers.has(c.sha),
      });
    }
    return {
      candidates: [...byPr.values()],
      truncated: missing.total_commits > missing.commits.length,
    };
  }

  async createBranch(name, sha) {
    await this.rest.git.createRef({
      ...this.base, ref: `refs/heads/${name}`, sha,
    });
  }

  async openPr({ head, base, title, body }) {
    const { data } = await this.rest.pulls.create({
      ...this.base, head, base, title, body,
    });
    return { number: data.number, html_url: data.html_url };
  }

  async createRelease(params) {
    const { data } = await this.rest.repos.createRelease({
      ...this.base, ...params,
    });
    return data;
  }

  async publishDraft(id, { make_latest }) {
    const { data } = await this.rest.repos.updateRelease({
      ...this.base, release_id: id, draft: false, make_latest,
    });
    return data;
  }

  async generateNotes(tag, target, previousTag) {
    const params = { ...this.base, tag_name: tag, target_commitish: target };
    if (previousTag) params.previous_tag_name = previousTag;
    const { data } = await this.rest.repos.generateReleaseNotes(params);
    return { name: data.name, body: data.body };
  }

  /** `{ status, state }`; any failure is reported, never thrown. */
  async workflowState(file) {
    try {
      const res = await this.rest.actions.getWorkflow({
        ...this.base, workflow_id: file,
      });
      return { status: res.status, state: res.data ? res.data.state : null };
    } catch (err) {
      return { status: err.status || 0, state: null };
    }
  }

  async listActiveRuns(workflowFile) {
    const byId = new Map();
    for (const status of ACTIVE_STATUSES) {
      const runs = await this.github.paginate(this.rest.actions.listWorkflowRuns, {
        ...this.base, workflow_id: workflowFile, status, per_page: 100,
      });
      for (const r of runs) {
        byId.set(r.id, {
          id: r.id, workflow: workflowFile,
          display_title: r.display_title, status: r.status,
        });
      }
    }
    return [...byId.values()];
  }

  async dispatch(workflowFile, ref, inputs) {
    await this.rest.actions.createWorkflowDispatch({
      ...this.base, workflow_id: workflowFile, ref, inputs,
    });
  }
}

module.exports = { ABANDONED_LABEL, Gh, pypiVersions };
