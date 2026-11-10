# 11 — Plugin bundles (Agent Plugins v1, Claude Code, Codex)

`muster plugins inspect|install|list|remove` accept three existing plugin formats and make their MCP servers and skills active on every Muster runtime **without running any plugin code**:

- **Agent Plugins v1:** `plugin.json` at the root, `mcp.json` or `.mcp.json`, `skills/<name>/SKILL.md`, optional `commands/`.
- **Claude Code plugins:** `.claude-plugin/plugin.json`, `.mcp.json` (or `mcpServers` in the manifest), `skills/`, `commands/`, `agents/`, `hooks/`.
- **Codex plugins:** `.codex-plugin/plugin.json` with `mcpServers` (usually `./.mcp.json`) and `skills` (usually `./skills/`).

An installed bundle is a copy of the source in the profile's plugin directory (`<profile data>/plugins/<id>`), recorded in `<profile data>/plugins/plugins.lock.json` with its source, commit SHA (git sources) and a sha256 content digest. Its MCP servers are added to `config.tools.mcp.servers` as `<id>__<server>` and marked with `origin.plugin = <id>`. Its skills are discovered in place: each installed bundle's skills directory is a skill root. Commands, agents, hooks and apps are recorded as "not activated (needs register API)". Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-11-1A — Inspect shows exactly what install adds, without running plugin code

- **Precondition:** an Agent Plugins v1 bundle `weather-kit` with a stdio server whose env holds a literal secret value, a remote http server, a skill, a command, and a `package.json` `postinstall` script that would write a marker file.
- **Action:** `muster plugins inspect <path>`.
- **Expected result:** the output names the format, each server as `<id>__<server>` with its command or URL, env and header **names only** (never values), the skill, the command as "not activated (needs register API)", and flags the remote URL and the command that resolves outside the bundle. The marker file is never written.
- **Test:** `packages/cli/test/plugin-bundles.test.ts` › "inspect lists servers, skills and ignored parts of an Agent Plugins v1 bundle without running it"
- **Environment:** temp workspace after `muster init`; real CLI through `tsx`.
- **Known gaps:** `package.json` scripts are not analysed beyond being reported as never run.
- **Evidence:** live run 2026-11-09, built CLI, `muster plugins inspect` on a one-tool Agent Plugins v1 bundle: `~/.muster-work/review/screens/plugin-bundles/01-inspect-install-list.png`.

## MUS-SPEC-11-1B — Installing an Agent Plugins v1 bundle activates its servers and skills

- **Precondition:** the same bundle, not yet installed.
- **Action:** `muster plugins install <path>`, then `muster skills list` and `muster mcp list`.
- **Expected result:** the bundle is copied to the profile plugin directory; the lock records `source.type=local`, the source path and a `sha256:` digest; `config.tools.mcp.servers` gains `weather-kit__forecast` with `origin.plugin=weather-kit`, `${PLUGIN_ROOT}` expanded to the installed path and `${WEATHER_API_KEY}` kept as a reference; the bundle's skill is listed by `muster skills list`; no plugin code ran.
- **Test:** `packages/cli/test/plugin-bundles.test.ts` › "installing an Agent Plugins v1 bundle adds prefixed MCP servers and discoverable skills"
- **Environment:** temp workspace; real CLI.
- **Known gaps:** skill names are not namespaced by plugin; a user skill with the same name wins.
- **Evidence:** same live run: install, `plugins list`, `skills list`, `mcp list` in `01-inspect-install-list.png`.

## MUS-SPEC-11-1C — Claude Code plugins install with `${CLAUDE_PLUGIN_ROOT}` resolved

- **Precondition:** a bundle with `.claude-plugin/plugin.json`, `.mcp.json` (`{"mcpServers":{…}}`) using `${CLAUDE_PLUGIN_ROOT}`, a skill, `commands/`, `agents/` and `hooks/hooks.json`.
- **Action:** `muster plugins inspect <path>` then `muster plugins install <path>`.
- **Expected result:** inspect reports format `claude-code` and lists commands, agents and hooks as not activated; after install the server's args point at the installed copy, and the skill is discoverable.
- **Test:** `packages/cli/test/plugin-bundles.test.ts` › "a Claude Code plugin installs with CLAUDE_PLUGIN_ROOT resolved and hooks recorded but not run"
- **Environment:** temp workspace; real CLI.
- **Known gaps:** Claude `userConfig` values (`${user_config.*}`) are not prompted for; LSP servers and output styles are reported as ignored.
- **Evidence:** UNVERIFIED

## MUS-SPEC-11-1D — Codex plugins install from a git URL at a resolved commit

- **Precondition:** a git repository containing a `.codex-plugin/plugin.json` bundle whose server uses `"command": "./bin/server"` and `"cwd": "."`, plus `env_vars`.
- **Action:** `muster plugins install file://<repo>`.
- **Expected result:** a shallow clone at the repository's HEAD; the lock records `source.type=git`, the URL and the 40-hex commit equal to HEAD; the server command is the absolute path inside the installed copy, `cwd` is the installed copy, and each `env_vars` name becomes an env reference `${NAME}`; no `.git` directory is kept.
- **Test:** `packages/cli/test/plugin-bundles.test.ts` › "a Codex plugin installs from a git URL pinned to the resolved commit"
- **Environment:** temp workspace; local git repository served over `file://`.
- **Known gaps:** `#<ref>` may name a branch, tag or full commit; private repositories rely on the user's git credentials.
- **Evidence:** UNVERIFIED

## MUS-SPEC-11-1E — An installed bundle's MCP server reaches a Codex turn

- **Precondition:** the Agent Plugins v1 bundle installed; `WEATHER_API_KEY` set in the environment.
- **Action:** `muster run "<prompt>" --runtime codex --transport warm` against a fake Codex app-server.
- **Expected result:** the thread config carries `mcp_servers.weather-kit__forecast` with the installed command and args and the env reference expanded from the environment; the value is not in the app-server's argv. A plugin server whose referenced env variable is unset is left out of the turn (the resolver reports `needs <VAR> in the environment`).
- **Test:** `packages/cli/test/plugin-bundles.test.ts` › "an installed bundle's MCP server is passed to a Codex turn with env references resolved at turn time"
- **Environment:** fake app-server via `MUSTER_CODEX_COMMAND`.
- **Known gaps:** references resolve only from the process environment (no secret store yet).
- **Evidence:** live run 2026-11-09, `muster chat --runtime codex` (real Codex app-server) called `tide-kit__tides.harbour_tide` and quoted its answer: `~/.muster-work/review/screens/plugin-bundles/02-chat-codex-plugin-tool.png`.

## MUS-SPEC-11-1F — List and remove undo exactly what install did

- **Precondition:** two bundles installed and a user-added server `mine` in `config.tools.mcp.servers`.
- **Action:** `muster plugins list`, then `muster plugins remove weather-kit`.
- **Expected result:** list shows each bundle with format, source, SHA (or `-` for local), servers and skills counts. Remove deletes only the servers whose `origin.plugin` is `weather-kit`, the lock entry and the installed copy; `mine` and the other bundle stay; the bundle's skill is no longer listed.
- **Test:** `packages/cli/test/plugin-bundles.test.ts` › "list shows installed bundles and remove deletes exactly their servers, skills and files"
- **Environment:** temp workspace; real CLI.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-11-1G — Governance: deny list, high-risk gate and path escapes

- **Precondition:** a bundle whose id is in `config.plugins.deny`; a bundle that declares `"risk": "high"`; a bundle whose manifest points outside its root (`"mcpServers": "../elsewhere.json"`).
- **Action:** `muster plugins install` each.
- **Expected result:** the denied bundle is refused; the high-risk bundle is refused without `--allow-high-risk` and installs with it; the escaping bundle is blocked at inspect and install. Nothing is written for refused installs.
- **Test:** `packages/cli/test/plugin-bundles.test.ts` › "denied, high-risk and path-escaping bundles are refused"
- **Environment:** temp workspace; real CLI.
- **Known gaps:** there is no kill list or signed catalog for bundles yet.
- **Evidence:** UNVERIFIED

## MUS-SPEC-11-1H — A Codex turn can read an installed bundle's skill through `skill_view`

- **Precondition:** an initialized workspace; a Claude-format bundle with skill `greet` ("Greet the user warmly") installed with `muster plugins install`. The turn prompt advertises "Available skills (read with skill_view before relying on one)". Codex turns reach Muster's tools through `muster mcp serve`, which chat attaches to every turn.
- **Action:** an MCP client starts `muster mcp serve`, lists tools and calls `skill_view {"name":"greet"}`, then `skill_view {"name":"nope"}`.
- **Expected result:** `tools/list` includes `skill_view` with a `name` input; the call returns the skill's name, description and full body; an unknown name is an `isError` result that names the skill. Still no shell or file-write tools.
- **Test:** `packages/cli/test/mcp-serve.test.ts` › "skill_view over MCP returns an installed bundle's skill"
- **Environment:** the real CLI as a child process, temp workspace.
- **Known gaps:** skill files referenced from SKILL.md (scripts, references) are not served; the model reads them from the path given.
- **Evidence:** UNVERIFIED

## MUS-SPEC-11-1I — Inspect on a missing or empty folder says what it looked for

- **Precondition:** a workspace; no folder `nope`; an empty folder `empty`.
- **Action:** `muster plugins inspect <cwd>/nope`, then `muster plugins inspect <cwd>/empty`.
- **Expected result:** both fail without a raw `ENOENT`. The first says `No such folder: …/nope`; the second says `No plugin found in …/empty` and names the files it looked for (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `plugin.json`, or a capability pack's `manifest.json`).
- **Test:** `packages/cli/test/plugin-bundles.test.ts` › "plugins inspect on a missing or empty folder says what it looked for"
- **Environment:** real CLI via tsx, temp workspace.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED
