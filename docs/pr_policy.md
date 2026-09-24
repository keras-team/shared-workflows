# Keras Pull Request Policy

To keep review bandwidth focused on high-leverage improvements and prevent duplicate work, external pull requests across `keras-team` repositories require a **linked, approved issue assigned to the PR author**.

> **NOTE:** We're constantly evolving this policy for optimal project velocity. If you have any feedback, please chime in on [keras#23601](https://github.com/keras-team/keras/issues/23601).

## Overview of Requirements

1. **Open or find an issue first**:
   - Before opening a pull request, find an existing issue or open a new issue describing the bug or feature.
   - If an issue is open for contributions, comment on the issue to request assignment.
2. **Wait for issue assignment**:
   - Once a maintainer approves the direction and **assigns the issue to you**, you can proceed with opening a PR.
3. **Link the assigned issue in your PR description**:
   - Include a reference to the issue in your PR description (for example, `Fixes #xxx` under the `## Approved issue link` section).
4. **Complete the Contributor Agreement checklist**:
   - Check all required boxes in the PR description's Contributor Agreement section.
5. **Stay responsive during review**:
   - You may have up to **3 PRs** ready for review at a time (additional PRs should remain in draft).
   - Feel free to run `/gemini review` on your PR to catch minor issues while waiting for a maintainer review.
   - PRs with no activity for 7 days will be marked as stale and closed after 7 additional days.

---

## Automated Enforcement (`pr-approved-issue`)

Our automated workflow checks every pull request from external contributors when a PR is `opened`, `edited`, `reopened`, or marked `ready_for_review`:

- **Who is checked**: All external contributors (`FIRST_TIME_CONTRIBUTOR`, `CONTRIBUTOR`, `NONE`). Repository owners (`OWNER`), organization members (`MEMBER`), collaborators (`COLLABORATOR`), and bots (`Bot` / `[bot]`) are exempt.
- **How issues are matched**:
  - The workflow strips HTML comments (`<!-- ... -->`) from the PR description and scans for issue references belonging to the same repository (`#xxx`, `owner/repo#xxx`, or `https://github.com/owner/repo/issues/xxx`).
  - Pull request numbers are ignored — the linked number must be an **issue** in the repository, and your GitHub username must be in the issue's **Assignees** list.
- **Draft state behavior**:
  - **When the check fails**: If your PR does not link an issue assigned to you and is not currently a draft, the workflow automatically converts the PR to **Draft**, posts a comment explaining how to resolve it, and fails the check.
  - **When the check passes**: Once you link an issue assigned to you in the PR description, the status check passes (`✅`). If your PR was in **Draft**, it stays in draft until you click **Ready for review** yourself.

---

## FAQ

### My PR was converted to a draft — how do I get it reviewed?

1. Ensure an issue for your change exists in the repository and has been **assigned to you** by a maintainer.
2. Edit your PR description to link that issue (e.g., `Fixes #xxx` under `## Approved issue link`).
3. Wait for the `PR approved issue check` status to pass (`✅`), then click **Ready for review** on your PR.

### Multiple people offered to send a PR for an issue — how is assignment decided?

1. In general, assignment is first-come, first-served, with the reporter of the issue given the first opportunity to submit a PR.
2. Maintainers may author PRs directly based on urgency and priority.
3. If an issue is assigned to a contributor and there is no PR or activity within 7 days, it may be reassigned to the next volunteer.
