# 06 — Claude Code turns stream like every other runtime

When `muster chat` runs on the Claude Code runtime (including Claude models reached through a gateway such as OmniRoute via `ANTHROPIC_BASE_URL`), the transcript shows Claude's commands and tool calls, streams its text, and reports exact token usage. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-06-1A — Tool calls, streamed text and real usage from a Claude turn

- **Precondition:** runtime `claude-code`; Claude reads `calc.py`, runs `pytest -q` (exit 0, "1 passed"), then answers.
- **Action:** run the turn through `executeRun` with `onDelta` and `onToolEvent`.
- **Expected result:** tool events arrive in order — start/end `Read calc.py`, start/end command `pytest -q` with its output; the streamed deltas join to the final answer; the run's tokens are the provider's numbers (input = uncached + cache read + cache write, cached = cache read, output), not estimates.
- **Test:** `packages/core/test/claude-stream.test.ts` › "claude turns report tool calls, stream text and record real usage"
- **Environment:** fake `claude` binary printing stream-json.
- **Known gaps:** Claude Code's own permission prompts are not routed to Muster yet.
- **Evidence:** UNVERIFIED

## MUS-SPEC-06-1B — A Claude binary without stream-json still answers

- **Precondition:** an older `claude` that ignores `--output-format stream-json` and prints plain text.
- **Action:** run the same turn.
- **Expected result:** the plain text is the answer; no crash, no empty reply.
- **Test:** `packages/core/test/claude-stream.test.ts` › "a claude that prints plain text still answers"
- **Environment:** fake `claude` binary.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-06-1C — A file write is shown once, as its diff card

- **Precondition:** chat on `claude-code`; Claude writes `note.txt` with its `Write` tool (or changes a file with `Edit`/`MultiEdit`/`NotebookEdit`).
- **Action:** the stream carries the `tool_use` and its successful `tool_result` ("File created successfully at: …").
- **Expected result:** no tool event for the successful edit — the workspace observer's `Create(note.txt)` diff card is the one cell for it, as on Codex. A failed edit (`is_error: true`) still reports a start and a failed end, so the error is visible.
- **Test:** `packages/core/test/claude-stream.test.ts` › "claude file writes are left to the diff card; a failed write still shows"
- **Environment:** fake `claude` printing stream-json, no network.
- **Known gaps:** outside a git repo there is no live diff, so a successful write has no card there (same as Codex).
- **Evidence:** UNVERIFIED
