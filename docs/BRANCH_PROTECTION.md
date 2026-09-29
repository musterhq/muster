# Branch protection for `main`

Recommended settings (a repository admin applies these under Settings > Branches):

- Require a pull request before merging. Do not require code-owner review: the only maintainer, @Dkm0315, cannot
  approve their own PRs, so a required review would force an admin bypass on every merge. Add a required-approvals
  rule only once there is a second maintainer. `.github/CODEOWNERS` exists only to request reviews automatically.
- Require status checks to pass, and require branches to be up to date.
- Block force pushes and deletion of `main`.

## Required status checks

| Check name | Workflow |
| --- | --- |
| `validate` | `Muster CI` (`.github/workflows/ci.yml`): typecheck, PTY/TUI evidence, tests, build, CLI smoke |

`ci.yml` runs on every pull request with no path filter, so it is safe to require. Do not require any check from a
path-filtered workflow: if the filter skips it, the check stays "Expected" and blocks the merge. (`pages.yml`,
`release.yml` and `npm-doctor.yml` do not run on pull requests and must not be required.)

## Workflow safety notes

- No workflow uses `pull_request_target`; the PR workflow gets no secrets and only `contents: read`.
- `NPM_TOKEN` is used only by `release.yml` and `npm-doctor.yml`, both manual (`workflow_dispatch`).
- `release.yml` passes the dispatch input through an environment variable, not directly into shell.
