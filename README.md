# Keras Shared Workflows (`keras-team/shared-workflows`)

Shared, reusable GitHub Actions workflows for repositories across the [`keras-team`](https://github.com/keras-team) organization.

---

## Workflows

### 1. 🏷️ Gemini Issue Triage (`gemini-issue-triage.yml`)

Automated issue triage, label classification, and user assistance using Gemini.

**Key Features & Security Hardening:**
- **RCE Prevention**: Explicitly restricts `coreTools: []` in `run-gemini-cli` to prevent prompt-injection attacks from executing runner commands.
- **Label Allowlist**: Deterministically verifies requested labels against the repository allowlist before mutating issue metadata.
- **Static Response Templates**: Avoids arbitrary LLM comment injection by using parameterized, maintainer-reviewed response templates.
- **Controlled Auto-Close**: Only closes issues strictly identified as user error / question with known workarounds.

#### Usage in Repositories (`.github/workflows/gemini-automated-issue-triage.yml`):

```yaml
name: '🏷️ Gemini Automated Issue Triage'

on:
  issues:
    types: [opened, reopened]
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Issue number to triage'
        required: true
        type: number

jobs:
  triage:
    if: |-
      github.event_name == 'workflow_dispatch' ||
      (
        (github.event_name == 'issues' || github.event_name == 'issue_comment') &&
        (github.event_name != 'issue_comment' || (
          (contains(github.event.comment.body, '@keras-team/triage') || contains(github.event.comment.body, '@keras-team /triage')) &&
          (github.event.comment.author_association == 'OWNER' || github.event.comment.author_association == 'MEMBER' || github.event.comment.author_association == 'COLLABORATOR')
        ))
      )
    uses: keras-team/shared-workflows/.github/workflows/gemini-issue-triage.yml@main
    secrets:
      GEMINI_API: ${{ secrets.GEMINI_API }}
    with:
      allowed_labels: 'backend:jax,backend:tensorflow,backend:torch,backend:OpenVino,Gemma,layers,python,dependencies,Duplicate,stale,stat:awaiting response from contributor,stat:awaiting keras-eng,Good first issue,keras-team-review-pending,stat:contributions welcome,wont-fix,user error,to investigate'
      gemini_model: 'gemini-3.5-flash'
```

---

### 2. 💬 Jules PR Q&A (`jules-review.yml`)

Maintainer-gated PR review assistant powered by Google Jules. Triggered via `@jules <question>` in PR review comments or conversations.

#### Usage in Repositories (`.github/workflows/jules-review.yml`):

```yaml
name: 'Jules PR Q&A'

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  jules:
    if: |
      (github.event_name == 'pull_request_review_comment' || github.event.issue.pull_request) &&
      contains(github.event.comment.body, '@jules') &&
      contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)
    uses: keras-team/shared-workflows/.github/workflows/jules-review.yml@main
    secrets:
      JULES_API_KEY: ${{ secrets.JULES_API_KEY }}
```

---

### 3. 👥 Auto-Assignment (`auto-assignment.yml`)

Round-robin issue and pull request assignment to triage team members.

#### Usage in Repositories (`.github/workflows/auto-assignment.yml`):

```yaml
name: 'Auto Assignment'

on:
  issues:
    types: [opened]
  pull_request_target:
    types: [opened]

jobs:
  assign:
    uses: keras-team/shared-workflows/.github/workflows/auto-assignment.yml@main
    with:
      issue_assignees: 'maitry63,mrinalghoshh,dhantule'
```
