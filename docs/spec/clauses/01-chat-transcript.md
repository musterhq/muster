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

## MUS-SPEC-01-6A — Diff cards show turn time readably

- **Precondition:** a diff card detected 67 985 ms into the turn, another at 86 ms, another at 105 975 ms (and one at 12 400 ms).
- **Action:** render the result rows.
- **Expected result:** `1m 8s`, `86ms` and `1m 46s` — the same duration format as command cells, never a raw five- or six-digit millisecond count.
- **Test:** `packages/cli/test/live-diff-render.test.ts` › "diff card timing reads like command timing"
- **Environment:** pure renderer.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-01-2C — A turn that ends with a cell still open closes the cell

- **Precondition:** chat; a turn started `sleep 30; echo finished` and its cell shows `⎿ running…`.
- **Action:** press Esc (the turn is interrupted before the command ends). Separately: a turn ends (failure, lost event) without a tool end for an open cell.
- **Expected result:** the same cell (no second cell) updates in place to `⎿ interrupted`, or `⎿ no result (the turn ended)` when the turn ended on its own; no cell says `running…` after its turn is over.
- **Test:** `packages/cli/test/chat-tool-cards.test.ts` › "a cell still running when the turn ends is closed as interrupted"
- **Environment:** chat harness with the narration painter, exactly as runChatTurn wires it.
- **Known gaps:** whether the provider stops the child process on interrupt is the runtime's job, not the painter's.
- **Evidence:** UNVERIFIED

## MUS-SPEC-01-1G — A reply the provider retries is painted once

- **Precondition:** runtime `codex` (app-server) on a gateway provider whose stream end Codex cannot parse (observed live on `hybrow:cc/claude-sonnet-5-5`: `error` notification "Reconnecting... 1/1", `willRetry: true`, `failed to parse ResponseCompleted: missing field cached_tokens`). Codex re-sends the request and streams the same answer again under a new item id.
- **Action:** run a turn: message item `m1` streams "four five six", then the retry `error`, then item `m2` streams "four five six" again.
- **Expected result:** the deltas the chat receives read "four five six" once. If the retried answer differs, it is painted as a new paragraph; if it extends the first, only the new tail is painted.
- **Test:** `packages/core/test/codex.test.ts` › "runCodexAppServer: a retried response is not streamed twice"
- **Environment:** fake app-server replaying the live event order.
- **Known gaps:** the gateway's malformed `response.completed` (missing `cached_tokens`) is the upstream cause and is not fixed here; every such turn costs a second model call.
- **Evidence:** live, 2026-11-10 — app-server stdout tee in `/tmp/qafix-dup-log` showed `error{willRetry:true}` between two identical agentMessage items.

## MUS-SPEC-01-2D — A command the provider did not time still shows its time

- **Precondition:** chat TUI on Codex, which reports `durationMs: 0` for most quick commands.
- **Action:** a command starts, ends 1.234 s later with `durationMs: 0`; a second command ends with `durationMs: 19900`.
- **Expected result:** the first cell reads `⎿ exit 0 · 1.2s` (Muster measured start→end); the second `⎿ exit 0 · 19.9s` (the provider's own time wins when it is non-zero).
- **Test:** `packages/cli/test/chat-tool-cards.test.ts` › "a command the provider reports as 0 ms shows the time Muster measured"
- **Environment:** chat harness with the narration painter and an injected clock, NO_COLOR.
- **Known gaps:** a running cell still shows only `running…` until it ends; Codex output deltas are not streamed into the cell (QA-12, second half).
- **Evidence:** live, 2026-11-10 tmux 110 cols, built CLI: `⏺ Bash(ls -la)` / `⎿ exit 0 · 75ms`, `printf …` / `⎿ exit 0 · 50ms` (before: `⎿ exit 0`). Red→green: chat-tool-cards.test.ts.

## MUS-SPEC-01-2E — Commands read as the shell runs them, and use the terminal width

- **Precondition:** Codex reports commands wrapped in a login shell and quoted for it: `/bin/zsh -lc "printf 'hello\\n' > hello.txt"`.
- **Action:** paint the command's cell (and its approval card) at 200 columns.
- **Expected result:** the title reads `printf 'hello\n' > hello.txt` — the wrapper's own escaping (`\\`, `\"`, `'\''`) is undone, so the text matches what the shell ran; a 168-character command is shown whole at 200 columns (the 96-character cap applies only when the width is unknown).
- **Test:** `packages/cli/test/chat-tool-cards.test.ts` › "command titles drop the wrapper's quoting and use the terminal width"
- **Environment:** pure `unwrapShellCommand`; chat harness with a painter given a 200-column width; NO_COLOR.
- **Known gaps:** a title is measured when the cell is painted; resizing later does not re-measure it.
- **Evidence:** live, 2026-11-10: the cell reads `⏺ Bash(printf 'hello\n' > hello.txt)` (before: `'hello\\n'`), and the hook script received the same bare text. Red→green: chat-tool-cards.test.ts.

## MUS-SPEC-01-3B — A long result line is cut to the width with an ellipsis

- **Precondition:** a tool cell whose output is one 128-character line ("File created successfully at: … no need to Read it back)").
- **Action:** render the cell at 80 columns, collapsed and then expanded (Ctrl+O).
- **Expected result:** collapsed, the output takes one row, cut to the width and ending in `…`; no row is wider than the terminal. Expanded, the full line is shown, wrapped.
- **Test:** `packages/cli/test/chat-tool-cards.test.ts` › "a long tool result line is cut to the terminal width with an ellipsis"
- **Environment:** pure renderer (`formatToolEndLines` → `renderTranscriptLine`), NO_COLOR.
- **Known gaps:** none.
- **Evidence:** live, 2026-11-10, Codex turn running `python3 -c "print('abc '*60)"`: the output row is 110 columns ending `abc…`. Red→green: chat-tool-cards.test.ts.

## MUS-SPEC-01-7A — Reasoning summaries do not wear the spinner's glyph

- **Precondition:** chat TUI; the live status row is the spinner `✻ Working` / `✻ Composing`.
- **Action:** the provider streams reasoning summaries ("Implementing now", "Waiting for next input") during a turn.
- **Expected result:** each summary row starts with `∴ ` (violet, italic), never `✻ `, so a finished turn shows no row that looks like a stale spinner; the spinner keeps `✻`.
- **Test:** `packages/cli/test/tui-stream-render.test.ts` › "reasoning summaries use their own glyph, not the spinner's"
- **Environment:** narration painter, NO_COLOR.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED live — three gpt-6.1-terra turns in tmux (`/tmp/polish-tr`, `/reasoning full`) emitted no reasoning summary, so the row could not be shown live; red→green: tui-stream-render.test.ts (painter emits `∴ Implementing now`).

## MUS-SPEC-01-7B — A blank row separates a tool cell from the narration after it

- **Precondition:** chat TUI; a turn narrates, runs `ls -la`, then narrates again.
- **Action:** the cell ends and the next message delta arrives.
- **Expected result:** one blank row sits between the cell's last row and the next `●` block (cells already have a blank row above them); consecutive narration in one block gets no extra blank row.
- **Test:** `packages/cli/test/chat-tool-cards.test.ts` › "the narration after a tool cell starts below a blank row"
- **Environment:** chat harness with the narration painter, exactly as runChatTurn wires it; NO_COLOR.
- **Known gaps:** none.
- **Evidence:** live, 2026-11-10, tmux 110 cols, built CLI, `/tmp/polish-tr`: `⏺ Bash(ls -la …)` cell, then a blank row, then `● add subtracts b from a instead of adding them.` (before: the `●` row sat directly under the cell's last output row, S/46-narrow80). Capture: `screens/polish/qa40-after-gap.ansi`. Red→green: chat-tool-cards.test.ts.

## MUS-SPEC-01-8A — MCP cells show the call's arguments and a summary of a JSON result

- **Precondition:** chat on Codex; the model calls `orders.lookup_order` with `{"id": 4411}` and `muster.memory_write`, whose result is a pretty-printed JSON record.
- **Action:** the provider emits `item/started` and `item/completed` for the `mcpToolCall` items.
- **Expected result:** the headline reads `⏺ MCP(orders.lookup_order · id: 4411)` (arguments as `key: value`, strings quoted, cut to the width). A JSON result is summarised collapsed as one `key: value` row per top-level field (`id: "mem_…"`, `scopes: ["user:dhairya"]`, …, at most five rows plus `… +N more fields`), not the raw tail (`"redactionState": "none",` / `"links": []`); Ctrl+O shows the full JSON. Plain-text results are unchanged.
- **Test:** `packages/cli/test/chat-tool-cards.test.ts` › "MCP cells show the arguments and summarise a JSON result"
- **Environment:** `codexItemToToolEvent` on recorded item shapes; chat harness with the narration painter; NO_COLOR.
- **Known gaps:** Claude Code and pi MCP calls carry no arguments into the cell yet.
- **Evidence:** live, 2026-11-11, tmux 110 cols, built CLI, Codex turn calling Muster's own server: `⏺ MCP(muster.memory_write · scopes: ["user:dhairya"], summary: "Polish team lunch is on Friday at Saffr…)` / `⎿ done · 7ms` / `id: "mem_91d34fa3-…"` / `memory: {"id":…,"kind":"fact",…` (before: `MCP(muster.memory_write)` and the raw tail `"redactionState": "none",` / `"links": []`, S/31-memwrite). Capture: `screens/polish/qa33-after-mcp-cell.ansi`. Red→green: chat-tool-cards.test.ts.

## MUS-SPEC-01-9A — `--history` shows local times with a zone, and each message keeps its own time

- **Precondition:** a session with a turn sent at 12:52:30 local time (07:22:30 UTC, zone Asia/Kolkata) whose answer was stored at 12:52:44.
- **Action:** `muster chat --session <name> --history` (also `/history`).
- **Expected result:** the user row reads `user      12:52:30 GMT+5:30` and the assistant row `assistant 12:52:44 GMT+5:30`: local time with a zone marker, a date in front when the message is not from today; the user's message is stored with the time the turn started, not the time the answer arrived.
- **Test:** `packages/cli/test/chat-tui.test.ts` › "history times are local with a zone and the prompt keeps the turn's start time"
- **Environment:** pure `formatLocalTimestamp` with fixed zones and clock; a session store in a temp folder.
- **Known gaps:** messages stored before this change keep the answer's time for the prompt.
- **Evidence:** live, 2026-11-11, built CLI, `/tmp/polish-rw`, one Codex turn then `chat --session hist-1 --history`: `user      12:55:35 GMT+5:30` / `assistant 12:56:02 GMT+5:30` (before: `user      07:22:44` / `assistant 07:22:44`, UTC with no marker, same time for both). Capture: `screens/polish/qa36-after-history.txt`. Red→green: chat-tui.test.ts.

## MUS-SPEC-01-10A — Tool cells are named for the tool, on every runtime

- **Precondition:** a Claude Code turn calls `Read` on `notes.md` and `Grep` for `TODO`; a pi turn calls `read` on `a.ts`.
- **Action:** the runtimes emit their tool events.
- **Expected result:** the cells read `⏺ Read(notes.md)`, `⏺ Grep(TODO)` and `⏺ Read(a.ts)`, never `Tool(Read notes.md)`. Commands stay `Bash(…)`, MCP calls stay `MCP(…)`.
- **Test:** `packages/cli/test/chat-tool-cards.test.ts` › "tool cells are named for the tool on claude and pi"
- **Environment:** harness sink and painter; core event mappers.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11: CLI `chat-tool-cards.test.ts` with access-approvals and ux-guards 27/27 (red first). Found in live QA pass 2: a Claude `Read` showed as `Tool(Read notes.md)`.
