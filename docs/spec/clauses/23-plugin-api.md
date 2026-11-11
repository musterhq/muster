# 23 — Plugin API: code plugins with `register(ctx)`, isolated by default

Bundles (spec 11) carry MCP servers, skills and commands, and run no code of their own. This clause adds **code plugins**: an ES module whose `register(ctx)` adds tools, hooks and chat commands.

What makes them safer than the usual plugin system:
1. **Out of process by default.** Every third-party plugin runs in its own Node child process. `ctx` calls are proxied over JSON-RPC on stdio. A crash or hang in a plugin never takes the chat down.
2. **Declared permissions, enforced.** The manifest lists what the plugin may do (`tools`, `hooks:<event>`, `commands`, `net:<host>`, `env:<NAME>`, `fs:read`/`fs:write` workspace-relative). Each permission is shown at install time. A registration or call outside the declared set is refused, with a receipt.
3. **A manifest you can read without running code.** `muster plugins inspect` never executes the plugin.
4. **A ledger.** Every registration is recorded with its inverse, so disable and remove unwind cleanly with no restart.
5. **Pinned and revocable.** A git install pins the commit, a kill list (`removed.json` in the hub index) blocks known-bad plugins on every install and load path, and `muster plugins validate` runs in CI for catalog entries.

Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

Manifest (`muster.plugin.json` at the plugin root):
```json
{
  "id": "weather",
  "version": "1.0.0",
  "entry": "dist/index.js",
  "description": "Current weather for a city",
  "permissions": ["tools", "hooks:tool.after", "commands", "net:api.open-meteo.com", "env:WEATHER_UNITS"],
  "configSchema": { "type": "object", "properties": { "units": { "enum": ["metric", "imperial"] } } }
}
```
Entry: `export async function register(ctx) { ctx.tool({...}); ctx.hook("tool.after", fn); ctx.command({...}); }`

## MUS-SPEC-23-1A — Inspect reads the manifest and never runs plugin code

- **Precondition:** a plugin folder whose `entry` writes a marker file when imported.
- **Action:** `muster plugins inspect <dir>`.
- **Expected result:** prints `id`, `version`, `kind=code` and each permission in plain words (`net:api.open-meteo.com` → "may make network requests to api.open-meteo.com"). The marker file does not exist afterwards. An invalid manifest (unknown permission, missing `entry`, `entry` outside the folder) is reported as an error with the field name.
- **Test:** `packages/cli/test/plugin-api.test.ts` › "inspect describes a code plugin's permissions without importing it"
- **Environment:** temp dirs.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11 on `feat/plugin-api`: core `test/plugin-host.test.ts` 6/6, CLI `test/plugin-api.test.ts` with plugin-bundles, chat-dictation and ux-guards 34/34, at concurrency 1; `qa run pty_tui` passed. Live: `muster plugins inspect /tmp/plugin-live/weather` printed `kind=code`, each permission in words and `runs_plugin_code=no`.

## MUS-SPEC-23-1B — A code plugin's tool runs in its own process and reaches every runtime

- **Precondition:** the plugin from the manifest above, installed and enabled. Its tool `weather_now({city})` returns `{"city": "Pune", "tempC": 31}` from a fake server.
- **Action:**
  1. List Muster's MCP tools (`muster mcp serve`, tools/list).
  2. Call `weather_now`.
  3. Read the process table during the call.
- **Expected result:**
  - The tool is listed with its schema, and the call returns the plugin's result.
  - The call ran in a child process (pid ≠ the CLI's pid).
  - Because Muster's own MCP server is attached to Codex, Claude Code and pi turns (spec 04), the tool reaches every runtime with no extra config.
- **Test:** `packages/cli/test/plugin-api.test.ts` › "a code plugin's tool is served over Muster's MCP server from an isolated host process"
- **Environment:** a fake HTTP server; an in-process MCP client.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11 on `feat/plugin-api`: core `test/plugin-host.test.ts` 6/6, CLI `test/plugin-api.test.ts` with plugin-bundles, chat-dictation and ux-guards 34/34, at concurrency 1; `qa run pty_tui` passed. Live: through `muster mcp serve`, `weather_now {city: Pune}` returned `{"city":"Pune","tempC":31}` from a local server.

## MUS-SPEC-23-1C — Permissions are enforced at registration and at call time

- **Precondition:** a plugin declaring only `["tools"]` whose `register` also calls `ctx.hook("tool.before", …)`, and whose tool fetches `https://evil.example` and reads `env.OPENAI_API_KEY`.
- **Action:** load the plugin, then call its tool.
- **Expected result:**
  - The hook registration is refused: the plugin still loads, and a warning names the missing `hooks:tool.before`.
  - The fetch is refused before any connection, with an error naming the undeclared host.
  - `OPENAI_API_KEY` is absent from the plugin's environment. Only `env:` names that are declared are passed, plus PATH and HOME.
  - Each refusal writes a receipt (`plugin.denied`, plugin id, permission).
- **Test:** `packages/core/test/plugin-host.test.ts` › "undeclared hooks, hosts and env vars are refused with receipts"
- **Environment:** a host child process; a fake HTTP server that records any connection.
- **Known gaps:** a plugin can still open raw sockets through `node:net`. The host blocks `node:net`, `node:child_process`, `node:worker_threads` and `node:fs` writes outside the workspace by loading the plugin under a Node permission policy (`--permission` with `--allow-fs-read`/`--allow-fs-write` scoped to the plugin dir and the workspace). This is noted as defence in depth, not a sandbox. A plugin can write its own lines to the protocol channel (fd 3); the parent accepts only `ready`, `denied`, `fetch` requests and replies to requests it sent and has not yet answered, ignores the rest and counts them in a `plugin.protocol_ignored` receipt, so forged lines can only affect that plugin's own results.
- **Evidence:** green 2026-11-11 on `feat/plugin-api`: core `test/plugin-host.test.ts` 6/6, CLI `test/plugin-api.test.ts` with plugin-bundles, chat-dictation and ux-guards 34/34, at concurrency 1; `qa run pty_tui` passed. Live: `weather_leak` got `ctx.fetch refused: example.com is not declared in the plugin's permissions (add "net:example.com")`.

## MUS-SPEC-23-1D — Hooks from a plugin can block, with the plugin named

- **Precondition:** a plugin with `hooks:tool.before` that blocks any command containing `rm -rf`.
- **Action:** a Codex turn (fake app-server) asks to run `rm -rf build`.
- **Expected result:**
  - The command is declined.
  - The chat shows the policy Blocked card with `blocked by plugin weather-guard: <reason>`.
  - The model is told why (steer, as in spec 12).
  - A plugin hook that throws or takes longer than 2 s counts as `pass` unless the manifest sets `"failClosed": true`, and it is logged.
- **Test:** `packages/core/test/plugin-host.test.ts` › "a plugin tool.before hook blocks a command and the block names the plugin"
- **Environment:** fake app-server, host child.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11 on `feat/plugin-api`: core `test/plugin-host.test.ts` 6/6, CLI `test/plugin-api.test.ts` with plugin-bundles, chat-dictation and ux-guards 34/34, at concurrency 1; `qa run pty_tui` passed.

## MUS-SPEC-23-1E — Chat commands from a plugin appear in the slash menu

- **Precondition:** a plugin that registers `/forecast <city>`, which returns text.
- **Action:** open the chat slash menu; run `/forecast Pune`.
- **Expected result:** `/forecast` is listed with its description and a `(weather)` source tag. Running it prints the plugin's text as a command reply, and no model turn starts. A command whose name collides with a built-in is refused at registration.
- **Test:** `packages/cli/test/plugin-api.test.ts` › "a plugin command is listed in the slash menu and runs without a model turn"
- **Environment:** harness sink.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11 on `feat/plugin-api`: core `test/plugin-host.test.ts` 6/6, CLI `test/plugin-api.test.ts` with plugin-bundles, chat-dictation and ux-guards 34/34, at concurrency 1; `qa run pty_tui` passed. Live: in `muster chat`, `/fore` listed `/forecast <city>  Current forecast for a city (weather)`; `/forecast Pune` printed `Forecast for Pune: 31°C, clear` with no model turn.

## MUS-SPEC-23-2A — Disable and remove unwind every registration with no restart

- **Precondition:** the weather plugin enabled; an open chat.
- **Action:** `muster plugins disable weather`, then (in the same chat) list tools and the slash menu; then `muster plugins remove weather`.
- **Expected result:**
  - After disable, the tool, hook and command are gone and the host process has exited.
  - The ledger file lists each registration with `undone: true`.
  - Remove deletes the plugin files and its lock entry. Re-enabling a disabled plugin restores exactly the same registrations.
- **Test:** `packages/cli/test/plugin-api.test.ts` › "disable unwinds tools, hooks and commands through the ledger and remove deletes the plugin"
- **Environment:** temp workspace.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11 on `feat/plugin-api`: core `test/plugin-host.test.ts` 6/6, CLI `test/plugin-api.test.ts` with plugin-bundles, chat-dictation and ux-guards 34/34, at concurrency 1; `qa run pty_tui` passed. Live: `plugins disable weather` → `enabled=no`; `plugins remove weather` removed the files and the list entry; no plugin process was left.

## MUS-SPEC-23-2B — A crashing or hanging plugin never takes the chat down

- **Precondition:** a plugin whose tool calls `process.exit(1)`; another whose tool never resolves.
- **Action:** call each tool.
- **Expected result:**
  - The first call returns an error, `plugin weather crashed (exit 1); restarted`. The host restarts at most 3 times in 60 s, then the plugin is marked `failed`, with the reason shown in `muster plugins list`.
  - The second call times out after `timeoutMs` (default 30 s; 1 s in the test) with a clear error, and the host is restarted.
  - The CLI process keeps running in both cases.
- **Test:** `packages/core/test/plugin-host.test.ts` › "a crashing plugin is restarted with a cap and a hanging tool times out"
- **Environment:** host child.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11 on `feat/plugin-api`: core `test/plugin-host.test.ts` 6/6, CLI `test/plugin-api.test.ts` with plugin-bundles, chat-dictation and ux-guards 34/34, at concurrency 1; `qa run pty_tui` passed.

## MUS-SPEC-23-3A — Install pins, shows permissions and honours the kill list

- **Precondition:** a local git repo with the plugin at commit C; a hub index whose `removed.json` lists `evil-plugin`.
- **Action:**
  1. `muster plugins install <git-url>` (non-interactive, `--yes`).
  2. Install `evil-plugin`.
  3. Add `evil-plugin` to `removed.json` after it was installed (simulated by editing the cached index), then start a chat.
- **Expected result:**
  - The install prints every permission in plain words, and the lock records commit C.
  - `evil-plugin` is refused at install with the kill-list reason.
  - An already-installed plugin that is later listed is not loaded, and the chat shows one warning line.
- **Test:** `packages/cli/test/plugin-api.test.ts` › "install pins the commit, lists permissions and refuses kill-listed plugins at install and load"
- **Environment:** local git repo; fake hub index.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11 on `feat/plugin-api`: core `test/plugin-host.test.ts` 6/6, CLI `test/plugin-api.test.ts` with plugin-bundles, chat-dictation and ux-guards 34/34, at concurrency 1; `qa run pty_tui` passed. Live: `plugins install … --yes` printed each permission, `digest=sha256:cd6efc5f…`, and `it runs in its own process with only the permissions above`.

## MUS-SPEC-23-3C — Install works in a folder Muster has not seen yet

- **Precondition:** a folder with no `.muster/`; the weather plugin.
- **Action:** `muster plugins inspect <dir>`, then `muster plugins install <dir> --yes`, then `muster plugins list`.
- **Expected result:** inspect creates nothing. Install creates the default config and installs the plugin (exit 0, no raw `ENOENT`). List shows it.
- **Test:** `packages/cli/test/plugin-api.test.ts` › "install works in a folder without .muster and inspect still writes nothing"
- **Environment:** temp dirs.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11 on `feat/plugin-api`: core `test/plugin-host.test.ts` 6/6, CLI `test/plugin-api.test.ts` with plugin-bundles, chat-dictation and ux-guards 34/34, at concurrency 1; `qa run pty_tui` passed. Live: the first `install` in a fresh folder failed with `ENOENT … .muster/config.json` before this fix; after it, install, list, disable and remove all worked there.

## MUS-SPEC-23-3B — `muster plugins validate` is the catalog gate

- **Precondition:** plugins with each defect:
  - an unknown permission;
  - an entry that imports `../../core`;
  - an entry with a top-level side effect (it writes a file on import);
  - a missing `register` export;
  - a tool without an input schema.
- **Action:** `muster plugins validate <dir>` on each, and on the good weather plugin.
- **Expected result:** each defect gets a named finding and exit 1. The good plugin passes with exit 0. Validation loads the entry only inside a throwaway host with no permissions, and checks for side effects by diffing the plugin dir and the temp dir before and after the import.
- **Test:** `packages/cli/test/plugin-api.test.ts` › "validate names each defect and passes a good plugin"
- **Environment:** temp dirs.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11 on `feat/plugin-api`: core `test/plugin-host.test.ts` 6/6, CLI `test/plugin-api.test.ts` with plugin-bundles, chat-dictation and ux-guards 34/34, at concurrency 1; `qa run pty_tui` passed.

## Next slice (not in this clause)
- More registrars: `ctx.channel()` (a ChannelAdapter from spec 18), `ctx.speech()` (an STT/TTS provider from spec 21), `ctx.memoryProvider()`, `ctx.schedule()`.
- Python plugins through the same JSON-RPC host protocol.
- A curated catalog repo with SHA pins and tiers.
