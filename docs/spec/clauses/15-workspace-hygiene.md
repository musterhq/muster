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
