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

## MUS-SPEC-15-3A — `muster doctor` in a new folder says what to do, not a raw error

- **Precondition:** a folder with no `.muster/`.
- **Action:** `muster doctor`.
- **Expected result:** the config row reads `warn config  no Muster config in this folder yet`, followed by `fix  config  muster init (or muster doctor --fix)`. No `ENOENT` and no raw path error appear. Every row uses the same words as the environment checks: `pass` / `warn` / `fail`, never `ok` / `err`. The command makes no files.
- **Test:** `packages/cli/test/workspace-hygiene.test.ts` › "doctor in a new folder suggests init instead of printing ENOENT"
- **Environment:** temp folder; real CLI.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11: CLI `workspace-hygiene.test.ts` 3/3 (red first: `err config ENOENT … config.json`).

## MUS-SPEC-15-3B — `muster --help` is one short page; the full list is one command away

- **Precondition:** any folder.
- **Action:** `muster --help`; `muster help plugins`; `muster help all`.
- **Expected result:**
  - `--help` fits in 40 lines, grouped as Start / Work / Extend / Reach / More. It names `muster help <command>` and `muster help all`.
  - `help plugins` prints only the `muster plugins …` usage lines.
  - `help all` prints the full command list, which is what `--help` printed before.
- **Test:** `packages/cli/test/cli.test.ts` › "help is one short grouped page with help <command> and help all"
- **Environment:** real CLI.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11: CLI `cli.test.ts` help tests 3/3; `muster --help` is 26 lines (it was 131); `muster help plugins` prints the plugins usage only.
