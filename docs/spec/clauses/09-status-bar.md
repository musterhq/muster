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
- **Evidence:** live, 2026-11-10, second turn of a session: `✻ Reading · gpt-6.1-terra · High · qafix2-cx · 6.8s` (before: `… · 91.8k in / 387 out · $0.0000 · …`). Red→green: status-bar.test.ts.

## MUS-SPEC-09-1E — After a resize the bar is rebuilt for the new width

- **Precondition:** chat open at 110 columns; the bar reads `gpt-6.1-terra · High │ /private/tmp/qa-nogit │ ctx 7% │ 144.0k tok`.
- **Action:** the window is resized to 60 columns; a turn summary row (`▸ gpt-6.1-terra · … · 11.1s`) is longer than the width.
- **Expected result:** the bar is rebuilt for 60 columns, so low-priority segments drop out whole (never `… │ 144.`); the summary row's continuation keeps the row's indent instead of wrapping to column 0.
- **Test:** `packages/cli/test/status-bar.test.ts` › "after a resize the bar is rebuilt for the new width and the summary row keeps its indent"
- **Environment:** `FooterSlot` with `formatStatusBar` as its source; pure `renderTranscriptLine`.
- **Known gaps:** none.
- **Evidence:** live, 2026-11-10: after `tmux resize-window -x 60` the bar reads `gpt-6.1-terra · High │ /private/tmp/qafix2-rw │ ⎇ main` (segments dropped whole). Red→green: status-bar.test.ts.

## MUS-SPEC-09-2A — The full header stays inside its box

- **Precondition:** `appearance.header = full`; a 110-column terminal (box width 108); the summary row (`gpt-6.1-terra · codex · native · speed fast · … · 0 mcp · /help`) is longer than the box.
- **Action:** render the full header panel.
- **Expected result:** every row is exactly the box width with its right border; the summary row is cut with `…` inside the border; the title sits in the top border (`╭── Muster Agent · 2026-11-10 ──╮`) rather than a second border row inside the box; the session name and its counts each get their own row, uncut.
- **Test:** `packages/cli/test/status-bar.test.ts` › "the full header panel keeps every row inside its box"
- **Environment:** pure renderer, NO_COLOR-equivalent (ANSI stripped).
- **Known gaps:** below 100 columns the panel is cut by the frame like before; the compact header is the default there.
- **Evidence:** live, 2026-11-10 `/header full` at 110 columns: every box row is 108 wide, the title is in the top border, the summary row ends `0 plug… │`. Red→green: status-bar.test.ts.

## MUS-SPEC-09-2B — A chat names its runtime one way, and a session reopens on its runtime

- **Precondition:** the default runtime id is `native` (Codex's app-server); session `qa-4` last ran on `claude-code` / `sonnet`.
- **Action:** read the `/runtime` row's current value and `/status`; open the `/model` picker; quit and run `muster chat --session qa-4` (no `--runtime`/`--model` flags), then the same with `--model gpt-6.1-terra`.
- **Expected result:** the runtime is called `codex` in the slash menu, `/status` and the header (never `native` in one place and `codex` in another); after the `/model` picker loads Codex's model names the header is rebuilt, so header and status bar name the model the same way. Reopening `qa-4` starts on `claude-code` / `sonnet`; a flag on the command line wins over the remembered route.
- **Test:** `packages/cli/test/model-catalog.test.ts` › "runtime names match everywhere and a session reopens on the runtime and model it last used" and › "Claude Code's short model names read the same in the header and the status bar"
- **Environment:** pure name map; route store in a temp workspace.
- **Known gaps:** the header rebuild after the picker is proven in the live tmux run only.
- **Evidence:** live, 2026-11-10: `/status` and the `/runtime` row both say `codex`; after `/model` header and bar both say `GPT-6.1 Terra · High`; `muster chat --session qafix2-rw` reopened on `claude-code` / `sonnet`. Red→green: model-catalog.test.ts.
