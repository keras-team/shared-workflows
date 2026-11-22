# Keras Shared Workflows

Shared, reusable GitHub Actions workflows for repositories across [`keras-team`](https://github.com/keras-team).

## Release panel

One form releases any `keras-team` repo: **Actions > Release > Run workflow**.

1. Run `prepare` with the repo name and `major`, `minor` or `patch`. Leave
   `version` blank to have it computed from the highest `vX.Y.Z` tag, or type
   one. For `major` and `minor` the panel cuts `rX.Y` from master (at `commit`
   if given), or reuses it if it exists. For `patch` it applies `cherry_picks`
   onto the existing `rX.Y` in master's order. It then sets `__version__` and
   opens one PR into the release branch.
2. Review and merge that PR.
3. Run `draft-release` with the same inputs. It checks the release branch is
   at the version and drafts a GitHub release, with notes generated since the
   previous final release.
4. Edit the notes and click **Publish**. That creates the `vX.Y.Z` tag and
   starts the repo's own PyPI publish workflow.

`dry_run` is ticked by default and prints the computed version, branch and
cherry-picks without changing anything. The bot never merges a PR and never
publishes a release. You need write access to the repo you release.

Things to know:

- `stage: dev` gives `X.Y.Z.dev0` and a GitHub pre-release; `final` gives
  `X.Y.Z`. A typed `version` is used as is and `stage` is ignored.
- A blank `version` counts from the highest final tag. Type the version for a
  patch on an older line, a second dev release (`.dev1`) or an `rc`.
- If a newly cut branch is already at the version (a `dev` release cut from
  master), no PR is opened; go straight to `draft-release`.
- If a cherry-pick conflicts, nothing is pushed. Open that backport PR into
  `rX.Y` by hand, then run `prepare` again without that hash.
- Generated notes for a patch will usually list only the prepare PR; its
  description has the cherry-picked commits.
- Bumping master to the next dev version after a new branch is cut is a
  normal PR, not done by the panel.

A repo works with the panel when it has one `version.py` holding a
`__version__ = "..."` line, release branches named `rX.Y`, and a publish
workflow that runs on `release: [published]`.

### One-time admin setup

- A GitHub App installed on all `keras-team` repos with `contents`,
  `pull requests` and `workflows` write permission.
- A `release` environment in this repo holding the secrets
  `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_PRIVATE_KEY`, with **deployment
  branches restricted to `main`** so the secrets cannot be read from a
  workflow edited on another branch. Add required reviewers to also gate each
  run.
