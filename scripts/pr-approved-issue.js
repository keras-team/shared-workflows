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
 * Enforce that external PRs link an approved issue assigned to the author.
 *
 * - Strips HTML comments from the PR description and scans for issue references
 *   (`#xxx`, `owner/repo#xxx` or a full issue URL).
 * - Passes when at least one referenced issue exists in this repo and has the
 *   PR author as an assignee.
 * - When the check fails: converts non-draft PRs to draft, posts a comment (on
 *   `opened` or when converting to draft), and marks the check as failed.
 *
 * Maintainers, collaborators and bots are skipped by the workflow `if:`.
 */

const POLICY_DOC_URL =
  "https://github.com/keras-team/shared-workflows/blob/main/docs/pr_policy.md";
const BYPASS_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
// Historical RFC announcement issue in keras-team/keras that was linked in PR templates.
const IGNORED_REPO_ISSUES = {
  "keras-team/keras": new Set([23601]),
};

module.exports = async function prApprovedIssue({ github, context, core }) {
  const payloadPr = context.payload.pull_request;
  if (!payloadPr) {
    core.info("Not a pull request payload.");
    return;
  }

  const { owner, repo } = context.repo;
  const action = context.payload.action;

  // Fetch live PR state so re-running a failed workflow job reads the latest
  // PR description and draft status rather than the frozen event payload.
  const { data: pr } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: payloadPr.number,
  });
  const author = pr.user.login;

  // Defence in depth: the workflow `if:` already filters these out.
  if (
    pr.user.type === "Bot" ||
    author.toLowerCase().endsWith("[bot]") ||
    BYPASS_ASSOCIATIONS.includes(pr.author_association)
  ) {
    core.info(`Skipping #${pr.number}: ${author} is ${pr.author_association}.`);
    return;
  }

  const body = pr.body || "";

  // 1. Find issues referenced in the description that are assigned to the author.
  const referenced = findIssueNumbers(body, owner, repo);
  const assigned = [];
  const notAssigned = [];
  for (const number of referenced) {
    try {
      const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: number });
      if (issue.pull_request) continue; // A PR reference, not an issue.
      const assignees = (issue.assignees || []).map((a) => a.login.toLowerCase());
      (assignees.includes(author.toLowerCase()) ? assigned : notAssigned).push(number);
    } catch (err) {
      core.info(`Could not fetch issue #${number}: ${err.message}`);
    }
  }

  if (assigned.length > 0) {
    core.info(
      `Approved issue check passed for #${pr.number}: ${assigned.map((n) => `#${n}`).join(", ")} assigned to @${author}.`
    );
    return;
  }

  // 2. Check failed: convert non-draft PRs to draft.
  const wasNotDraft = !pr.draft;
  if (wasNotDraft) {
    await convertToDraft(github, core, pr);
  }

  // 3. Post a comment when the PR is opened or when converting a non-draft PR to draft.
  if (action === "opened" || wasNotDraft) {
    const message = [
      `❌ **Approved issue check failed.** This PR has been placed in **draft** until it links an approved issue assigned to @${author}.`,
      "",
      `Please review the [Keras Pull Request Policy](${POLICY_DOC_URL}). To resolve this:`,
      "1. Find or open an issue for this change and ask a maintainer to approve it and assign it to you.",
      "2. Link the issue in this PR's description (e.g. `Fixes #xxx`).",
      "3. Once this check passes, mark the PR **Ready for review** when it is ready.",
      "",
      notAssigned.length
        ? `Referenced issue(s) not assigned to @${author}: ${notAssigned.map((n) => `#${n}`).join(", ")}.`
        : "No issue reference was found in the description.",
    ].join("\n");

    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: pr.number,
      body: message,
    });
  }

  core.setFailed(`No approved issue assigned to ${author} is linked in #${pr.number}.`);
};

/** Collect issue numbers referenced in `body` (excluding HTML comments) that belong to this repo. */
function findIssueNumbers(body, owner, repo) {
  // Strip HTML comments so placeholders like <!-- Fixes #123 --> are never matched.
  const uncommented = body.replace(/<!--[\s\S]*?-->/g, "");
  const repoKey = `${owner}/${repo}`.toLowerCase();
  const ignored = IGNORED_REPO_ISSUES[repoKey] || new Set();

  const escaped = `${owner}/${repo}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`https?://github\\.com/${escaped}/issues/(\\d+)`, "gi"),
    new RegExp(`(?:^|[^\\w/])${escaped}#(\\d+)`, "gi"),
    // Bare `#123`, but not `owner/repo#123` of some other repo.
    /(?:^|[^\w/])#(\d+)\b/g,
  ];
  const numbers = new Set();
  for (const pattern of patterns) {
    for (const match of uncommented.matchAll(pattern)) {
      const num = Number(match[1]);
      if (!ignored.has(num)) {
        numbers.add(num);
      }
    }
  }
  return [...numbers];
}

async function convertToDraft(github, core, pr) {
  try {
    await github.graphql(
      `mutation($id: ID!) {
        convertPullRequestToDraft(input: {pullRequestId: $id}) {
          pullRequest { isDraft }
        }
      }`,
      { id: pr.node_id }
    );
    core.info(`Converted #${pr.number} to draft.`);
    return true;
  } catch (err) {
    const lines = [`Could not convert #${pr.number} to draft: ${err.message}`];
    if (/not accessible by integration/i.test(err.message)) {
      lines.push("Toggling draft state needs `contents: write` and `pull-requests: write`.");
    }
    core.warning(lines.join("\n"));
    return pr.draft;
  }
}
