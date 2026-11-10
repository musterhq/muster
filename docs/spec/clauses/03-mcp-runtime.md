# 03 — MCP servers reach every turn

MCP servers added with `muster mcp add-stdio|add-http` (stored in `config.tools.mcp.servers`) are tools the model can use on every runtime. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-03-1A — Codex turns get Muster's MCP servers without secrets on the command line

- **Precondition:** `config.tools.mcp.servers.notes` is a stdio server whose env holds `NOTES_TOKEN=s3cret-value`.
- **Action:** run a turn on the Codex runtime (app-server transport).
- **Expected result:** the provider thread is opened with the server in its per-thread config (`mcp_servers.notes` with command, args and env); the secret never appears in the app-server process arguments.
- **Test:** `packages/core/test/mcp-runtime.test.ts` › "codex turns receive configured MCP servers through thread config, never argv"
- **Environment:** fake app-server binary via `MUSTER_CODEX_COMMAND`.
- **Known gaps:** the `codex exec` fallback transport still uses `-c` overrides (no per-thread config there).
- **Evidence:** UNVERIFIED

## MUS-SPEC-03-1B — Claude Code turns get Muster's MCP servers through a private config file

- **Precondition:** the same `notes` server plus an http server `docs` with a static header.
- **Action:** run a turn on the Claude Code runtime.
- **Expected result:** Claude is started with `--mcp-config <file>`; the file is readable only by the user (0600) and lists both servers in Claude's format; it is deleted when the turn ends.
- **Test:** `packages/core/test/mcp-runtime.test.ts` › "claude turns receive configured MCP servers through a private --mcp-config file"
- **Environment:** fake `claude` binary.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-03-1C — Denied or disabled servers never reach a turn

- **Precondition:** `tools.deny` contains `mcp:blocked`, and `tools.entries.off.enabled` is false.
- **Action:** run a turn on either runtime.
- **Expected result:** neither `blocked` nor `off` is passed; allowed servers still are.
- **Test:** `packages/core/test/mcp-runtime.test.ts` › "denied and disabled MCP servers are not passed to any runtime"
- **Environment:** pure resolver.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-03-1D — Signed-in OAuth servers carry their token

- **Precondition:** http server `linear` with `auth: "oauth"` and a token saved by `muster mcp login linear`.
- **Action:** resolve the servers for a turn.
- **Expected result:** the server carries `Authorization: Bearer <token>`; an OAuth server with no saved token is skipped with a reason instead of failing the turn.
- **Test:** `packages/core/test/mcp-runtime.test.ts` › "oauth servers carry the saved token and unsigned ones are skipped with a reason"
- **Environment:** temp profile home.
- **Known gaps:** expired tokens are not refreshed here yet.
- **Evidence:** UNVERIFIED

## MUS-SPEC-03-2A — Muster's own server rides along with every chat turn

- **Precondition:** the chat passes `extraMcpServers.muster` (the CLI's own `mcp serve`); the user has no server named `muster`.
- **Action:** run a Codex turn; then run one with `tools.deny: ["mcp:muster"]`; then one where the user configured their own `muster` server.
- **Expected result:** the first thread config contains `mcp_servers.muster`; the denied run does not; the user's own `muster` entry wins over the extra one.
- **Test:** `packages/core/test/mcp-runtime.test.ts` › "extra servers ride along, obey deny rules, and never override the user's own"
- **Environment:** pure resolver.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-03-2B — A Claude turn with MCP servers still gets its prompt

- **Precondition:** at least one MCP server reaches a Claude Code turn (Muster's own server always does in chat).
- **Action:** run a Claude Code turn.
- **Expected result:** the prompt is passed after `--`, so `--mcp-config` (which takes several values) never swallows it; the fake `claude` receives the prompt as its last argument and the config file as the `--mcp-config` value.
- **Test:** `packages/core/test/mcp-runtime.test.ts` › "a claude turn with MCP servers passes the prompt after --"
- **Environment:** fake `claude` binary.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-03-2C — MCP commands work in a folder without `.muster/`

- **Precondition:** a fresh folder with no `.muster/` (only `git init`, or nothing).
- **Action:** `muster mcp add-stdio orders node server.mjs`; in another fresh folder `muster mcp list`.
- **Expected result:** both succeed, like `muster chat` and `muster config set` do: the project config is created (`.muster/config.json`, with `orders` added), never a raw `ENOENT … .muster/config.json`.
- **Test:** `packages/cli/test/plugin-bundles.test.ts` › "mcp add-stdio, list and test work in a folder without .muster/"
- **Environment:** real CLI via tsx, temp folders.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED
