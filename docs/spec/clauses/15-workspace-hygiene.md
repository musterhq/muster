# 15 — Workspace hygiene

Muster keeps per-workspace state in `.muster/`. In a git repository it must not show up as the user's work. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-15-1A — `.muster/` never appears as an untracked change

- **Precondition:** a git repository with no `.gitignore`.
- **Action:** run `muster init` twice.
- **Expected result:** `git status --porcelain` lists nothing under `.muster/`; `.git/info/exclude` contains exactly one `.muster/` line; no `.gitignore` is created or changed.
- **Test:** `packages/cli/test/workspace-hygiene.test.ts` › "muster state in a git repo is excluded locally, once, without touching .gitignore"
- **Environment:** real CLI, real git repo.
- **Known gaps:** worktrees share the main repo's `info/exclude` (git's own behaviour).
- **Evidence:** UNVERIFIED

## MUS-SPEC-15-2A — Commands do not print Node's SQLite experimental warning

- **Precondition:** Node 22–24, where loading `node:sqlite` emits `ExperimentalWarning: SQLite is an experimental feature…` plus the `node --trace-warnings` hint.
- **Action:** run any `muster` command (`muster --version`); separately, emit that warning and a `DeprecationWarning` after the CLI's warning filter is installed.
- **Expected result:** stderr has no SQLite experimental warning and no `--trace-warnings` hint; every other warning (the `DeprecationWarning`) is still printed.
- **Test:** `packages/cli/test/workspace-hygiene.test.ts` › "the SQLite experimental warning is hidden and other warnings still print"
- **Environment:** real CLI through tsx; a tsx child that installs the filter and emits both warnings.
- **Known gaps:** child processes Muster spawns with their own Node (plugins, MCP servers) keep Node's default warning output.
- **Evidence:** live, 2026-11-10, built CLI in `/tmp/polish-w`: `node packages/cli/dist/index.js --version`, `config list` and `status` print nothing to stderr (before: `(node:…) ExperimentalWarning: SQLite is an experimental feature…` and the `--trace-warnings` hint on every command); a `DeprecationWarning` emitted after the filter still prints. Red→green: workspace-hygiene.test.ts; cli.test.ts "CLI roster inspect and install verify entries into a lockfile" passes.
