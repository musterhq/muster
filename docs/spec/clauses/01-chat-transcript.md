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
