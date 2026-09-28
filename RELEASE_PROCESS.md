# Release Process

This repo runs releases for Keras repos from one place. You press a button
here; a GitHub App does the git work in the target repo; a separate workflow
builds, tests and uploads to PyPI.

Phase 1 covers **releases only** for **keras-hub**. Nightlies are out of scope
and still run from each repo's own `nightly.yml`.

## 1. The Release panel

The panel is the `release.yml` workflow in this repo: **Actions -> release ->
Run workflow**.

| Workflow | What it does | Who starts it |
| :--- | :--- | :--- |
| `release.yml` (the panel) | Works out the next step, then cuts the branch, cherry-picks, opens PRs, creates the draft or the release and tag | You |
| `publish.yml` | Builds, smoke-tests, runs generated tests, uploads to PyPI | The panel, automatically. A human can also start it directly to retry |

**Who can use it.** You need **write on the target repo** (e.g. keras-hub)
**and write on `shared-workflows`** (GitHub only shows Run workflow to
writers). Maintain counts as write. Triage does not. If you are a keras-hub
collaborator but not in a team with write here, ask an admin to add you.

**Branch picker.** The "Use workflow from" picker must be **`main`**. Only
reviewed code on `main` can reach the bot key and PyPI. Any other branch is
refused, dry runs included.

**The bot never merges.** It opens PRs. A human with write merges them, then
presses Release again.

## 2. Form fields

| Field | Type | Label shown in the form | Why it is there |
| :--- | :--- | :--- | :--- |
| `repository` | choice | Which repo to release (must be enabled in release/repos/). | Picks the target and its config file. Disabled repos are refused. |
| `channel` | choice | dev = pre-release X.Y.Z.devN (GitHub pre-release); stable = final release. | Decides whether the version gets a `.devN` suffix and the pre-release flag. |
| `kind` | choice | major = new X.Y line on a release branch (patch component 0); patch = X.Y.Z fix on an existing release branch. | Decides how the version is computed. |
| `release_branch` | string | Release branch, e.g. r0.33. Always required; used for the same-branch lock. | Every release happens on a release branch. The name also gives X.Y. |
| `commit_sha` | string | Major with a new branch only: the master commit to cut the branch from. | Where the new branch starts. Must be on master, and its version files must have the branch's X.Y. |
| `version` | string | Optional. Leave blank to use the computed version (the dry run shows it). Type one only to resume or re-publish a specific version. | Normally blank. Needed only to re-publish a version that is already released. |
| `cherry_picks` | string | Master PR numbers (recommended, e.g. #3101) or commit SHAs, any order; applied in master merge order. Allowed for patch, and for major when the release branch already exists (e.g. fixes before X.Y.0). | Fixes to carry from master onto the release branch. |
| `bump_master` | boolean | Also open a PR bumping master to the next dev version. | Saves a manual PR after cutting a branch. Skipped if master is already there. |
| `release_mode` | choice | auto: after you merge the version PR and run the panel again, tags, publishes the GitHub release and uploads to PyPI in one go. draft: creates a draft release with notes for you to review (no tag yet); run the panel again to publish, which creates the tag and uploads. The bot never merges the PR in either mode. | Lets you review release notes before anything is public. |
| `override_generated_tests` | boolean | Upload even if the Gemini-generated tests fail (e.g. a wrong generated test or a Gemini outage). The smoke install/import test always blocks. | See section 7. |
| `dry_run` | boolean, default on | Show what would happen and change nothing. Untick to act. | Always start with a dry run. |

There is no "action" field. The panel detects the next step from the state of
the branch, PRs, drafts, tags and releases.

`cherry_picks`, `commit_sha` and `bump_master` only apply when the detected
step is *prepare*. Giving them on any other step is refused, and the message
names the detected step.

## 3. Walkthroughs

### Always start with a dry run

Leave `dry_run` ticked. The summary shows:

- every release branch, its latest release and the suggested next version;
- for the chosen branch, the master PRs not yet on it (cherry-pick candidates);
- the detected step and the resolved version;
- stale bump PRs;
- a table of the exact form values to use for the real run.

A dry run writes nothing. It does hold the same-branch lock while it runs.

### What "Next:" means

Every run's summary ends with a `Next:` line. It tells you exactly what to do
now: merge PR #N, run again, or fix something first. Every real run also prints
the resolved version and the detected step at the top.

### How the panel decides what to do

For version V on branch B, the first match wins:

| # | State found | Step | What happens |
| :--- | :--- | :--- | :--- |
| 1 | A published (non-draft) release `vV` exists. Reached only with a typed `version`. | already-released | No repo writes. Re-runs `publish.yml` for that tag. |
| 2 | A draft with tag `vV` | publish | Re-checks the draft, publishes it (creates the tag), starts `publish.yml`. |
| 3 | Tag `vV` at the merge sha of the merged bump PR, no release | continue (resume) | Creates the release without re-tagging. |
| 4 | Merged `release-tool/bump-V` PR, no tag | continue | auto: tag + release + PyPI. draft: creates the draft. |
| 5 | Open `release-tool/bump-V` PR | no-op | "waiting for a human with write to merge PR #N". |
| 6 | Version files at B head already equal V, and no picks | fast-path | auto: tags B's head sha and publishes. draft: creates a draft at that sha. |
| 7 | Anything else | prepare | Cuts the branch if needed, applies picks, opens the bump PR. |

### New minor release with dev releases (example: 0.33)

Master's version must already be `0.33.0.devN` so the branch name and the
version agree.

**Cut the branch and release 0.33.0.dev0.**

1. Dry run: `repository=keras-hub`, `channel=dev`, `kind=major`,
   `release_branch=r0.33`, `commit_sha=<master sha>`. Optionally tick
   `bump_master`.
2. Untick `dry_run` and run. The bot creates `r0.33` at `commit_sha`.
   - If the new branch already has version `0.33.0.dev0`, it stops there: no
     PR, no tag. `Next:` says run again.
   - Otherwise it opens a bump PR into `r0.33`. Merge it.
   - If you ticked `bump_master`, it also opens a PR bumping master to the next
     dev version (branch `release-tool/master-bump-<V>`). Merge it when ready.
3. Run again with the same repository and branch. The panel picks fast-path
   (or continue, if there was a bump PR) and releases `0.33.0.dev0`.

Cherry-picks are refused when the branch is being created. The branch is cut
from `commit_sha`, which already contains master's fixes.

**Fixes before 0.33.0: release 0.33.0.dev1.**

1. Merge the fix on master first.
2. Run with `channel=dev`, `kind=major`, `release_branch=r0.33`,
   `cherry_picks=#3101`. Leave `commit_sha` blank (the branch exists).
3. The bot opens one PR into `r0.33` with the picks and a bump to
   `0.33.0.dev1`. A human merges it.
4. Run again. The continue step tags the merge commit and releases.

Each further dev release repeats this with the next `devN`.

**Final release 0.33.0.**

1. Run with `channel=stable`, `kind=major`, `release_branch=r0.33`. Add
   `cherry_picks` if there are last fixes.
2. Merge the bump PR (version `0.33.0`).
3. Run again. Continue releases `0.33.0`. It gets the Latest badge if it is the
   highest stable version in the repo.

### Patch release (example: 0.33.1)

1. Merge the fix on master.
2. Dry run with `channel=stable`, `kind=patch`, `release_branch=r0.33`,
   `cherry_picks=#3120, #3125`.
3. Untick `dry_run`. The bot opens a bump PR into `r0.33` with the picks and
   version `0.33.1`. A human merges it.
4. Run again. Continue releases `0.33.1`.

The patch version is the highest stable `v0.33.W` plus one. A patch needs a
stable `v0.33.0` first; without it the panel says "use kind=major". A patch on
an older line (e.g. 0.31.2 after 0.33.0) does not take the Latest badge.

### auto vs draft

| | auto | draft |
| :--- | :--- | :--- |
| Run after merging the bump PR | Creates tag + release in one call, then starts `publish.yml` | Creates a draft release with notes. No tag yet. |
| Next run | — | Publish step: publishes the draft (this creates the tag), then starts `publish.yml` |
| Clicks after the merge | 1 | 2 |

In draft mode you can edit the release notes. Do not change the tag or the
target commit: the publish step re-checks both and refuses an edited draft.

> **Do not publish the bot's draft from the GitHub UI.** That skips the PyPI
> upload. Always publish by running the panel again. If it happens, see the
> failure table.

The panel only publishes drafts created by the bot. A draft created by a human
is refused.

## 4. Cherry-picks

- Give master PR numbers (recommended) or commit SHAs, any order.
- Every PR must be merged into master. SHAs must be on master's first-parent
  history (a merge commit or a squash commit).
- The bot applies them oldest first, in master merge order, with
  `git cherry-pick -x`.
  - Squash-merged PR: picks the squash commit.
  - Merge-commit PR: picks the merge commit with `-m 1`.
  - **Rebase-merged PR: refused.** It has several commits on master and no
    single commit to pick. Give the individual SHAs instead.
- A pick already on the branch, or one that comes out empty, is skipped and
  reported. It is not an error.

**The pick record.** Every bump PR body carries a line like:

```
Cherry-picks: #3101 (abc1234), #3110 (def5678)
```

Later runs and the dry run read this line from PRs merged into the branch to
know what is already there. Any merge method is fine; squash-merging the bump
PR loses nothing.

**Conflicts.** On a conflict the bot aborts the cherry-pick and pushes
nothing. The summary lists the conflicting commit, the conflicting files, and
earlier master commits touching those files that you did not select. Then
either:

- run again with an adjusted list (often adding the missing earlier PR), or
- resolve by hand:
  1. Open a PR onto the release branch made with `git cherry-pick -x <sha>`.
  2. Add a `Cherry-picks: #N (sha)` line to its body, so later runs know it is
     there.
  3. A human merges it.
  4. Run the panel. It detects prepare, applies any remaining picks, and opens
     the bump PR.
  5. Merge the bump PR and run once more.

## 5. Same-branch refusal

Only one release can be in progress per repo and branch. The panel refuses
(it does not queue) when it sees any of these for the same branch:

- another active panel run (including a dry run);
- an active `publish.yml` run for a tag on that branch's line;
- an open bump PR into the branch (except the no-op wait for that same PR);
- a draft release for that branch (except the publish step for that same
  draft).

Why: two runs on one branch could pick the same version, tag twice, or race
each other's picks. Refusing is safer than guessing which one you meant.

- Two clicks at the same moment each see the other and both refuse. Click
  again.
- A run title the panel cannot parse counts as a match (fails closed).
- An in-flight release for a different version than the one you typed is
  refused and named. Two in-flight versions on one branch are refused and
  listed.

## 6. Failures and how to resume

Every step is idempotent. Running the panel again resumes at the first
incomplete step. It never opens a second PR or creates a second tag. The bot
creates a tag and its release in one API call, so a failure leaves either
nothing or a complete release.

| Situation | What you see | What to do |
| :--- | :--- | :--- |
| Prepare failed half-way | No PR, or a stale `release-tool/bump-V` branch | Run again. The bot rebuilds the bump branch from scratch and opens the PR. |
| Cherry-pick conflict | Conflict report; nothing pushed | See section 4. |
| `dispatch` job failed (release exists, `publish.yml` never started) | Panel run red at `dispatch` | Run the panel with `version=V`. The already-released step starts `publish.yml` again. |
| `publish.yml` failed (build, smoke, generated tests, upload) | `publish` run red | "Re-run failed jobs" on that run, or run the panel with `version=V`, or dispatch `publish.yml` directly with the tag. |
| Partial PyPI upload (e.g. keras-hub uploaded, keras-nlp not) | `publish` red after upload | Same as above. Files already on PyPI are skipped and listed as "published by an earlier run"; only missing files are uploaded and digest-checked. The run ends green once every expected file is on PyPI. |
| Released on GitHub but not on PyPI | First summary line: "vV is released on GitHub but not on PyPI; run with version=V to re-publish" | Run with `version=V`. Until fixed, prepare refuses to start the next version. |
| A human published the bot's draft from the GitHub UI | Release is public, nothing on PyPI (the tag ruleset may also block the UI publish for people outside the rollback team) | Run with `version=V` to upload. |
| Human-created draft on the branch | Publish refused; it also blocks the branch | Delete the draft. |
| Stale bump PR (merged, version already released or lower) | Listed as stale in the dry run | Nothing. It is ignored. |
| Closed, unmerged bump PR | — | Nothing. It is ignored; the next prepare opens a new PR. |
| Open bump PR you no longer want | No-op / branch refused | Close it. |
| Merged bump PR you want to abandon (never tagged; it blocks every other version) | In-flight release that you don't want | A human with write adds the label `release-tool:abandoned` to that PR, then runs again. A label added by a triage user is ignored. |
| Commits landed on the branch after the bump PR merged | Continue refuses: "these N commits would be left out of vV: ...; label PR #N `release-tool:abandoned` and run again to cut a version that includes them" | Add the label and run again. The next run usually takes fast-path at the new branch head, including those commits. |
| Tag `vV` created by hand at the bump PR's merge commit, no release | — | Run again. Continue creates the release without re-tagging. |
| You abandoned a bump PR, but tag `vV` already sits at its merge commit | Refused: "tag vV exists … not at the merge commit" | Ask the rollback team to delete tag `vV` (there is no release for it), then run again. |
| "Re-run failed jobs" on a panel (`release.yml`) run | `act`/`dispatch` refuse on attempt 2+ | Start a new panel run. A re-run skips the lock check in `plan`, so it is blocked. |
| "Re-run failed jobs" on `publish.yml` | Allowed | It re-uploads only the tag and digests that `validate` already approved. |
| Legacy publisher still enabled | Refused before any tag or publish | Disable keras-hub's `publish-to-pypi.yml` (section 8). |
| Gemini outage or a wrong generated test | `generate` or `generated-tests` red, upload skipped | Run again with `override_generated_tests` ticked (section 7). |
| Branch busy | Same-branch refusal | Wait for the other run, or finish/close the in-flight PR or draft. |

## 7. `override_generated_tests`

`publish.yml` runs two kinds of tests on the built wheels:

- **smoke**: fresh install and import on each backend. **Always blocks.**
- **generated tests**: tests written by Gemini from the release diff.

With the override ticked, the upload still runs when the generated tests
**failed**, including when Gemini itself failed (an outage counts as a
generated-tests failure). It does **not** cover:

- a failed build, smoke test or `validate`;
- generated tests that were cancelled or skipped.

The override only matters on the run that starts `publish.yml`: the continue
or fast-path run in auto mode, the publish run in draft mode, or an
already-released re-publish. The `publish` run report says when the override
was used.

## 8. Coexistence and rollback

- Phase 1 deletes nothing. keras-hub's legacy `publish-to-pypi.yml` stays in
  the repo, **disabled** in the Actions UI.
- That workflow runs on every push and uploads when a tag is pushed. If it were
  enabled, a tag created by the bot would upload a second time. So the panel
  checks it before any tag or publish and refuses unless it is disabled. Any
  error from that check also refuses.
- keras-hub's existing PyPI trusted publisher stays in place. The new one for
  `shared-workflows` is added next to it.

**To roll back:**

1. Re-enable `publish-to-pypi.yml` in keras-hub.
2. Stop using the panel for that repo.
3. A member of the rollback team (on the bypass lists of rulesets (b1) and
   (b2)) cuts the branch and creates the tag/release by hand, following the
   "Rollback only" section of keras-hub's `RELEASE_PROCESS.md`. Changes to
   release branches still go through PRs.

**Later (phase 2):** once a real upload through `shared-workflows` is proven,
the legacy file is deleted in the target repo. Only after that deletion lands
does a follow-up PR here set `legacy_publish_workflow` to `null` in the repo
config. Never before: until then a missing file makes the check fail, which
refuses (fails closed). The config loader rejects a config with the field
absent.

## 9. Admin setup checklist

Do these in order.

1. **[Admin] Environments.** On `shared-workflows`, Settings -> Environments,
   create `pypi`, `release`, `release-read`, `gemini`. For each: Deployment
   branches and tags -> "Selected branches and tags" -> add a rule of
   **type Branch** (not Tag) named `main`. A Tag rule, or a name pattern
   without the type, would let a writer push a *tag* called `main` and run a
   modified workflow in the environment. No required reviewers on `release`,
   `release-read`, `gemini`. Required reviewers on `pypi` are optional; they
   pause auto mode until someone approves.
2. **[Admin] `main` ruleset.** Settings -> Rules -> Rulesets -> New branch
   ruleset on `shared-workflows`, target `main`:
   - require a pull request with >= 1 approval;
   - require review from Code Owners;
   - dismiss stale approvals on new pushes;
   - require approval of the most recent push;
   - require status checks by job name: `unit-tests` (`Tests` is the workflow
     name, not a check), `pytest`, `zizmor`;
   - block force pushes and deletion;
   - **bypass list empty** (the App must never be on it).

   The existing CODEOWNERS (`* @keras-team/core @jeffcarp`) then covers
   `release/**`, `scripts/release/**` (the code that runs with the App key)
   and `.github/workflows/**`.
3. **[Admin] Secrets audit** (before step 5 adds writers). List the repo-level
   secrets (Settings -> Secrets and variables -> Actions) and the org-level
   secrets whose access includes `shared-workflows`. A workflow on any
   writer's branch can read them, so remove or re-scope anything not needed
   here. Leave `gemini-issue-triage.yml` and `jules-review.yml` alone: they
   are `workflow_call` workflows whose secrets come from the calling repo.
   Then Settings -> Actions -> General -> Workflow permissions = "Read
   repository contents and packages permissions", and untick "Allow GitHub
   Actions to create and approve pull requests".
4. **[Maintainer] Fork end-to-end run** is green; run links are in the PR
   description; the `shared-workflows` PR is merged. Until the App exists, any
   panel run fails at `plan` on the empty `RELEASE_APP_SLUG`. That is
   expected.
5. **[Admin] Create the release App** (org Settings -> Developer settings ->
   GitHub Apps -> New):
   - Owned by `keras-team`; webhook inactive; no event subscriptions; "Only on
     this account".
   - Repository permissions, one set for every installed repo: Contents, Pull
     requests, Workflows, Actions = Read and write; Metadata = Read. Nothing
     else. Each job narrows its own token (e.g. `dispatch` only ever holds
     `actions: write` on `shared-workflows`).
   - Install on "Only select repositories": `shared-workflows` and `keras-hub`.
     Add other targets when they are enabled.
   - Generate a private key. Put `RELEASE_APP_CLIENT_ID` (the App's Client
     ID, not its numeric App ID) and
     `RELEASE_APP_PRIVATE_KEY` in envs `release` and `release-read` only,
     never at repo or org level.
   - Set repo variable `RELEASE_APP_SLUG` on `shared-workflows` to the App's
     slug.
   - Put `GEMINI_API` in the `gemini` env.
   - Create three new rulesets in **keras-hub** (today `r*` branches have no
     rules, so the App could push to them):

     | Ruleset | Type | Target | Rules | Bypass list |
     | :--- | :--- | :--- | :--- | :--- |
     | (a) Release branches, PR required | branch | `r[0-9]*` | Require a PR (>= 1 approval); dismiss stale approvals when new commits are pushed; require approval of the most recent reviewable push; block force pushes and deletion | **Empty** (never the App) |
     | (b1) Release branch creation | branch | `r[0-9]*` | Restrict creations | Release App + rollback team |
     | (b2) Release tags | tag | `v[0-9]*` | Restrict creations, updates and deletions | Release App + rollback team |

     (a) makes "the bot never pushes to or merges into a release branch" a
     GitHub-enforced rule. Its two approval settings stop a writer from
     pushing a commit onto an open bump PR and approving it themselves. Do not
     enable "require signed commits": the bot's picks are unsigned. `[0-9]`
     keeps names like `refactor-x` unaffected. The rollback team (e.g.
     keras-hub release maintainers) lets a human still cut a branch and create
     a tag by hand during rollback.
   - **Write grants.** Grant each enabled target repo's writer team write on
     `shared-workflows` (needed to press Run workflow). Only these people can
     release; the maintainer sends the admin the list. Safe only after steps
     1, 2 and 3.
6. **[PyPI project Owner of `keras-hub` and `keras-nlp`, not a GitHub admin]
   Last admin step.** On pypi.org, each project -> Manage -> Publishing -> add
   a GitHub trusted publisher:

   | Field | Value |
   | :--- | :--- |
   | Owner | `keras-team` |
   | Repository name | `shared-workflows` |
   | Workflow name | `publish.yml` |
   | Environment name | `pypi` |

   This is additional. Keep the existing keras-hub publisher for rollback.
7. **[Maintainer] Disable the legacy workflow.** Disable keras-hub's
   `publish-to-pypi.yml` in the Actions UI (or
   `PUT /repos/keras-team/keras-hub/actions/workflows/{id}/disable`) before
   the first real run that can create a tag (continue, fast-path, or draft
   publish). The panel refuses otherwise.
8. **[Maintainer] First release.** Run the first KerasHub release through the
   panel. On a problem, re-enable the old workflow and roll back (section 8).
   **Follow-ups:** repeat the trusted publisher mapping (step 6), disabling
   the legacy workflow (step 7) and a live release for keras, keras-rs and
   kinetic, one repo at a time. Add each to the App's installation when it is
   enabled (step 5).

## 10. Security model

- **Only `main` holds keys.** Every environment with a secret (`release`,
  `release-read`, `gemini`, `pypi`) is limited to the branch `main`, and
  `main` needs a reviewed, Code-Owner-approved PR with no bypass.
- **Target code never sees a secret.** The target repo's build and tests run
  in jobs with no App key, no Gemini key and no PyPI access. The jobs holding
  the App key never run target repo code or git hooks, and never restore a
  cache.
- **The bot cannot merge or push to release branches.** No code calls a merge
  API, and keras-hub ruleset (a) blocks direct pushes with an empty bypass
  list. Every release change reaches the branch through a PR a human merged.
- **Every release is re-checked before upload.** `validate` checks the
  requester has write on the target, the tag's commit is on a release branch,
  a published release exists, and the version files match the tag. The
  panel only publishes its own drafts, anchored to the merged bump PR.
- **What is uploaded is what was built.** Files are checked by sha256 between
  build and upload, and their metadata (name, version) is checked against the
  config and the tag. PyPI's copy is digest-checked afterwards.
- **Least privilege tokens.** App tokens are minted per job, scoped to one
  repo and the minimum permissions, and revoked at job end. PyPI uses OIDC
  trusted publishing; there is no PyPI token.
- **No script injection.** Free-text inputs reach scripts only through
  environment variables. zizmor runs on every PR.
- **Humans stay in the loop.** Pressing the panel needs write on both repos
  (triage is refused), and a human merges every bump PR.
