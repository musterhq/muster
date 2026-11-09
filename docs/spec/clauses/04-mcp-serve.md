# 04 — Muster as an MCP server

`muster mcp serve` exposes Muster's own abilities (memory, sessions, oversized results) as MCP tools over stdio, so any runtime or MCP client (Codex, Claude Code, an editor) can use them. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-04-1A — An MCP client can list and call Muster's tools

- **Precondition:** an initialized workspace.
- **Action:** start `muster mcp serve`; send `initialize`, `tools/list`, then `tools/call memory_write` ("Prefers metric units", scope `user:me`) and `tools/call memory_search` (scope `user:me`, query "metric").
- **Expected result:** `initialize` names the server `muster`; `tools/list` includes `memory_search`, `memory_get`, `memory_write`, `session_search`, `session_status`, `result_fetch`, each with an input schema, and no shell or file-write tools; the write returns the new memory id and the search finds it.
- **Test:** `packages/cli/test/mcp-serve.test.ts` › "an MCP client lists Muster's tools, writes a memory and finds it again"
- **Environment:** the real CLI as a child process, temp workspace.
- **Known gaps:** schedules and channel messaging tools come later.
- **Evidence:** UNVERIFIED

## MUS-SPEC-04-1B — Memory policy still governs writes through MCP

- **Precondition:** `memory.policy` is `never`.
- **Action:** `tools/call memory_write` without saying the user asked.
- **Expected result:** the call returns an MCP error result (`isError: true`) whose text explains the policy; nothing is written.
- **Test:** `packages/cli/test/mcp-serve.test.ts` › "memory_write through MCP obeys memory.policy"
- **Environment:** the real CLI as a child process.
- **Known gaps:** the `ask` policy needs an approval round-trip; until then it refuses.
- **Evidence:** UNVERIFIED
