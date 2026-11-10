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

## MUS-SPEC-09-1D — The working row shows this turn, not the session

- **Precondition:** a chat whose earlier turns used 91.8k input / 387 output tokens on a subscription (cost 0); a new turn has run 10.8 s.
- **Action:** render the working row for the running turn; render a status line with cost 0, and one with cost $0.0123.
- **Expected result:** the working row shows the verb, model, session and `10.8s` — no token counts (they belong to earlier turns; this turn's are known when it ends) and no `$0.0000`. A status line never shows a zero cost; a real cost still shows (`$0.0123`).
- **Test:** `packages/cli/test/status-bar.test.ts` › "the working row shows this turn's time, not session totals or a zero cost"
- **Environment:** pure renderers, injected clock.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-09-1E — After a resize the bar is rebuilt for the new width

- **Precondition:** chat open at 110 columns; the bar reads `gpt-6.1-terra · High │ /private/tmp/qa-nogit │ ctx 7% │ 144.0k tok`.
- **Action:** the window is resized to 60 columns; a turn summary row (`▸ gpt-6.1-terra · … · 11.1s`) is longer than the width.
- **Expected result:** the bar is rebuilt for 60 columns, so low-priority segments drop out whole (never `… │ 144.`); the summary row's continuation keeps the row's indent instead of wrapping to column 0.
- **Test:** `packages/cli/test/status-bar.test.ts` › "after a resize the bar is rebuilt for the new width and the summary row keeps its indent"
- **Environment:** `FooterSlot` with `formatStatusBar` as its source; pure `renderTranscriptLine`.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED
