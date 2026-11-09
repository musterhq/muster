# 09 — Status bar

A one-row bar under the composer answers "what am I running, where, and how full is it" at a glance. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-09-1A — The bar shows model, folder, git state, context and spend

- **Precondition:** chat in a git repo on branch `main` with one modified tracked file and one untracked file; the last turn used 50 000 prompt tokens of a 200 000-token window; the session has used 128 400 tokens and $0.42.
- **Action:** render the bar at width 120.
- **Expected result:** one row containing `gpt-6.1-terra · High`, the shortened folder, `⎇ main *1 ?1`, `ctx 25%`, `128.4k tok`, `$0.42`; at width 60 the lowest-priority segments drop out instead of wrapping.
- **Test:** `packages/cli/test/status-bar.test.ts` › "the status bar shows model, folder, git state, context and spend, and fits the width"
- **Environment:** real temporary git repo; pure formatter.
- **Known gaps:** context % is unknown on runtimes that do not report a window (the segment is omitted, never guessed).
- **Evidence:** UNVERIFIED

## MUS-SPEC-09-1B — Codex turns report context occupancy

- **Precondition:** Codex reports `tokenUsage.last.inputTokens = 50000` and `modelContextWindow = 200000`.
- **Action:** run a turn through `executeRun`.
- **Expected result:** the outcome carries `context = { usedTokens: 50000, windowTokens: 200000 }` from the latest model call.
- **Test:** `packages/core/test/codex.test.ts` › "runCodexAppServer: reports context occupancy from the latest call"
- **Environment:** fake app-server.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-09-1C — The bar sits under the composer

- **Precondition:** chat harness with a footer set.
- **Action:** render the visible screen.
- **Expected result:** the footer row is the last row, below the composer.
- **Test:** `packages/cli/test/status-bar.test.ts` › "the footer renders below the composer"
- **Environment:** chat harness.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED
