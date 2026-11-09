# 01 — Chat transcript

What `muster chat` paints while a turn runs. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-01-1A — Commands the agent runs appear in the transcript

- **Precondition:** chat on the Codex runtime; the provider runs a shell command during the turn.
- **Action:** the provider emits `item/started` and `item/completed` for a `commandExecution` item.
- **Expected result:** the run reports a tool start (command text) and a tool end (exit code, output, duration) to the caller, in order, between the narration blocks that surround it.
- **Test:** `packages/core/test/codex.test.ts` › "runCodexAppServer: reports command items, separates message items, and sums turn usage"
- **Environment:** fake app-server process (stdio JSON-RPC), no network.
- **Known gaps:** MCP and web-search items are mapped but only commands are asserted here.
- **Evidence:** UNVERIFIED

## MUS-SPEC-01-1B — A command renders as a cell with status and output

- **Precondition:** chat TUI painter active.
- **Action:** narration "Running the tests." streams, then a command starts and ends with exit 1 and 9 lines of output.
- **Expected result:** the narration is painted first; then `⏺ Bash(pytest -q)`; then a dim `⎿ exit 1 · 1.2s` result; output tail limited with a "… +n lines" count; the next narration opens a new `●` block.
- **Test:** `packages/cli/test/tui-stream-render.test.ts` › "narration painter paints command cells in order with exit status and output tail"
- **Environment:** pure renderer, NO_COLOR.
- **Known gaps:** no expand key yet (#132).
- **Evidence:** UNVERIFIED

## MUS-SPEC-01-1C — Separate assistant messages never glue together

- **Precondition:** one turn produces two assistant message items.
- **Action:** item `m1` streams "…run pytest." and item `m2` streams "add currently subtracts…".
- **Expected result:** the caller receives a paragraph break between the two items.
- **Test:** same as 01-1A.
- **Environment:** fake app-server.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-01-1D — Turn token usage covers every model call in the turn

- **Precondition:** a turn makes two model calls.
- **Action:** the provider emits two `thread/tokenUsage/updated` notifications.
- **Expected result:** the turn's usage is the sum of both calls (input, cached, output).
- **Test:** same as 01-1A.
- **Environment:** fake app-server.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-01-1E — Build artifacts are not reported as the agent's edits

- **Precondition:** repo without a `.gitignore`.
- **Action:** a turn edits `calc.py`; running Python writes `__pycache__/calc.cpython-314.pyc` and `.pytest_cache/v/cache/nodeids`.
- **Expected result:** one card (`calc.py`); the turn summary says 1 file changed.
- **Test:** `packages/cli/test/live-diff-render.test.ts` › "live diff feed skips build artifacts even without a .gitignore"
- **Environment:** injected observer.
- **Known gaps:** the list is fixed (`__pycache__`, `*.pyc`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `node_modules`, `.DS_Store`).
- **Evidence:** UNVERIFIED

## MUS-SPEC-01-1F — Markdown links and snake_case render verbatim

- **Precondition:** assistant text `Added [test_calc.py](/r/test_calc.py) for snake_case_names.`
- **Action:** render the block.
- **Expected result:** `Added test_calc.py for snake_case_names.` with the label underlined; no italics, no raw `[`/`](`.
- **Test:** `packages/cli/test/prose-renderer.test.ts` › "links render as their label and intraword underscores stay literal"
- **Environment:** pure renderer.
- **Known gaps:** no OSC 8 hyperlinks yet.
- **Evidence:** UNVERIFIED

## MUS-SPEC-01-2A — A tool cell updates in place from running to finished

- **Precondition:** chat TUI; a command starts, narration streams while it runs, then the command ends.
- **Action:** paint start → narration → end.
- **Expected result:** exactly one `Bash(…)` headline in the transcript, at the position where the command started; while running it shows `⎿ running…`; when it ends the same cell shows `⎿ exit 0 · 2.0s` and the output tail; the narration stays below the cell.
- **Test:** `packages/cli/test/chat-tool-cards.test.ts` › "a tool cell updates in place from running to finished"
- **Environment:** chat harness, painter wired to the sink's blocks, NO_COLOR.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-01-2B — Ctrl+O expands and collapses tool output

- **Precondition:** a finished command with 40 lines of output (collapsed to the tail with `… +N lines (ctrl+o to expand)`).
- **Action:** press Ctrl+O, then Ctrl+O again.
- **Expected result:** the first press shows all 40 lines and the hint changes to `ctrl+o to collapse`; the second restores the collapsed tail.
- **Test:** `packages/cli/test/chat-tool-cards.test.ts` › "ctrl+o expands every tool cell and collapses it again"
- **Environment:** chat harness.
- **Known gaps:** diff cards keep their own collapse rule for now.
- **Evidence:** UNVERIFIED

## MUS-SPEC-01-3A — Tool and diff cards sit on a full-width band; failures are tinted

- **Precondition:** chat TUI with color; a finished command cell (success), a failed command cell, and a diff card.
- **Action:** render the transcript rows at width 100.
- **Expected result:** every row of a card is painted with the card background across the full width (padding included); a failed command's rows use the failure tint; a blank unbanded row separates consecutive cards; the visible text of each row is unchanged.
- **Test:** `packages/cli/test/chat-tool-cards.test.ts` › "cards render as full-width bands, failures tinted, separated by a gap"
- **Environment:** pure row renderer used by the chat screen (`renderTranscriptLine`), truecolor.
- **Known gaps:** NO_COLOR terminals get no band (text only).
- **Evidence:** UNVERIFIED

## MUS-SPEC-01-4A — Diff cards show line numbers

- **Precondition:** a diff card for `@@ -9,4 +9,5 @@` with one context line, one removal, two additions, one context line.
- **Action:** render the card without color.
- **Expected result:** the hunk header stays; every body row is `<line number> <sign> <code>`, numbered from the hunk header — context and added rows use the new file's numbers, removed rows the old file's — right-aligned to the widest number in the card; the `+N −M` summary and receipt are unchanged.
- **Test:** `packages/cli/test/live-diff-render.test.ts` › "diff cards number every row from the hunk header"
- **Environment:** pure renderer.
- **Known gaps:** word-level (intra-line) highlighting is a follow-up.
- **Evidence:** UNVERIFIED

## MUS-SPEC-01-5A — A multi-file turn ends with a per-file summary

- **Precondition:** a turn changes three files (`src/a.ts` +2 −1, `README.md` +1 −0, `test/a.test.ts` +5 −0) in that order.
- **Action:** the turn ends.
- **Expected result:** the summary row `▸ 3 files changed · +8 −1` is followed by one row per file in change order with aligned paths and its own `+N −M`; a one-file turn keeps only the summary row; more than 8 files show 8 rows and `… +N more files`.
- **Test:** `packages/cli/test/live-diff-render.test.ts` › "a multi-file turn ends with one row per file under the summary"
- **Environment:** live diff feed with an injected observer.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED
