# 26 — `muster migrate`: bring an existing agent setup over, read-only and reviewable

People switch harnesses when moving costs nothing. `muster migrate <source>` reads another agent setup on the machine and proposes what to bring into Muster:
- memory and the user profile;
- skills;
- MCP servers;
- channel credentials;
- scheduled jobs;
- agent rules.

It shows the plan, then applies only what the user picks.

Rules:
1. **Read-only on the source.** It never writes, moves or deletes anything under `~/.openclaw`, `~/.hermes`, `~/.claude`, `~/.codex` or the source paths. A test proves the source tree's hashes are unchanged.
2. **Secrets stay references.** Tokens found in a source config are never copied into Muster's files. Each one becomes an env reference (`botTokenEnv: "TELEGRAM_BOT_TOKEN"`). The plan says which variable to set, and `--write-env <file>` (opt-in, mode 0600) writes them to a dotenv file the user owns.
3. **Dry run by default.** `muster migrate openclaw` prints the plan. `--apply` (or picking items in the TUI) applies it. Applying is idempotent, and every applied item writes a receipt so `muster migrate undo <run-id>` can remove exactly what it added.

Sources in this slice: `openclaw` (`~/.openclaw`), `hermes` (`~/.hermes`), `claude` (`~/.claude`, `~/.claude.json`, project `.mcp.json`), `codex` (`~/.codex/config.toml`, AGENTS.md, `~/.codex/skills`). Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-26-1A — The plan lists what each source has, read-only

- **Precondition:** fixture trees for each source under a fake HOME:
  - `openclaw`: `openclaw.json` with `channels.telegram.botToken` and `channels.discord`; `workspace/USER.md` and `MEMORY.md`; `skills/figma/SKILL.md`; `cron/jobs.json` with one job; an MCP server.
  - `hermes`: `config.yaml`, `memories/MEMORY.md` and `USER.md`, `skills/x/SKILL.md`, `.env`.
  - `claude`: `~/.claude.json` mcpServers, `~/.claude/skills/y`, `CLAUDE.md`.
  - `codex`: `config.toml` `[mcp_servers.z]`, `AGENTS.md`, `skills/w`.
- **Action:** `muster migrate <source>` for each (dry run), then hash every file under the fake HOME.
- **Expected result:**
  - For each source a plan grouped as Memory / Profile / Skills / MCP servers / Channels / Schedules / Rules. Each item has a short description and its status: `new`, `already in Muster`, or `conflict` (same name, different content).
  - Secrets are shown as `•••• (from openclaw.json channels.telegram.botToken) → set TELEGRAM_BOT_TOKEN`.
  - No file under the fake HOME changed (hashes equal), and nothing was written to Muster.
- **Test:** `packages/cli/test/migrate.test.ts` › "migrate plans each source read-only and never shows a secret"
- **Environment:** a fake HOME with fixtures.
- **Known gaps:** The `openclaw` source's `memory/main.sqlite` is read through `node:sqlite` read-only (`readOnly: true`); unknown schemas are listed as `skipped: unknown memory schema` rather than guessed.
- **Evidence:** real run 2026-11-14, `muster migrate openclaw` (dry run) from /tmp/migrate-live against the real `~/.openclaw` (86 439 entries): exit 0; 22 items (20 new, 2 skipped) in all seven groups; `•••• (from openclaw.json channels.telegram.botToken) → set TELEGRAM_BOT_TOKEN`; 0 of 3 secret values from openclaw.json in the output; hash of names+sizes+mtimes+modes of `~/.openclaw` and `~/.claude/skills` c4b9c63a8d53b9a9 before and after; nothing written to /tmp/migrate-live. Test: 4/4 pass in migrate.test.ts.

## MUS-SPEC-26-1B — Applying brings items in as Muster-native, with secrets as env references

- **Precondition:** the `openclaw` fixture.
- **Action:** `muster migrate openclaw --apply --yes`.
- **Expected result:**
  - Memory entries are added through Muster's memory API with scope `user` and the tag `migrated:openclaw`. USER.md facts go into the profile.
  - Skills are copied into `.muster/skills/<name>` with their provenance recorded.
  - MCP servers are added to the config with env references.
  - The Telegram channel is configured in `gateway.json` with `botTokenEnv: "TELEGRAM_BOT_TOKEN"`; no token string appears in any Muster file (grep proves it).
  - The cron job becomes a Muster automation, disabled until the user enables it, so nothing fires twice.
  - A second `--apply` changes nothing and reports `already in Muster`.
- **Test:** `packages/cli/test/migrate.test.ts` › "apply imports memory, skills, mcp, channels and schedules with secrets as env references, idempotently"
- **Environment:** a fake HOME; temp workspace.
- **Known gaps:** none.
- **Evidence:** real run 2026-11-14 against a fixture HOME copy: `--apply --yes --write-env` run mig_20261114T151440_801d added 8 of 8 items (2 memory/profile, 1 skill, 1 MCP server, 2 channels, 1 automation disabled until `muster schedule enable sched_26b3116d`, 1 rule); gateway.json `telegram.botTokenEnv: "TELEGRAM_BOT_TOKEN"` with no inline token; 0 token strings in output or in the workspace; env file mode 600 with TELEGRAM_BOT_TOKEN and GITHUB_TOKEN; a second apply printed `Nothing to apply`; source tree hash ecb8d3810b1d0061 before and after.

## MUS-SPEC-26-1C — Conflicts are never overwritten silently

- **Precondition:** Muster already has a skill `figma` with different content, and an MCP server `github` with a different command.
- **Action:** `muster migrate openclaw --apply --yes`.
- **Expected result:** both are reported as conflicts and skipped. `--rename` imports them as `figma-openclaw` and `github-openclaw` instead. Nothing existing is changed.
- **Test:** `packages/cli/test/migrate.test.ts` › "conflicting skills and servers are skipped or renamed, never overwritten"
- **Environment:** as 26-1B.
- **Known gaps:** none.
- **Evidence:** test run 2026-11-14: conflict lines for figma and github with the existing files byte-identical; `--rename` added figma-openclaw and github-openclaw; the next plan reports them `already in Muster`.

## MUS-SPEC-26-1D — Undo removes exactly what a migration added

- **Precondition:** a completed `--apply` run R.
- **Action:** `muster migrate undo R`.
- **Expected result:** every item R added is removed: memory entries with R's receipt id, the copied skills, the MCP servers, the channel entries and the automations. Items that existed before R, and items the user edited after R (content hash differs), are kept and listed as `kept: edited after migration`.
- **Test:** `packages/cli/test/migrate.test.ts` › "migrate undo removes only what the run added and keeps later edits"
- **Environment:** as 26-1B.
- **Known gaps:** none.
- **Evidence:** real run 2026-11-14 on the fixture HOME copy: `muster migrate undo mig_20261114T151440_801d` → `Undone: 8 removed · 0 kept`, gateway.json (created by the run) removed, memory.jsonl empty; the test proves edited items are listed `kept: edited after migration` and items from before the run stay.

## MUS-SPEC-26-2A — Onboarding offers migration when it finds another setup

- **Precondition:** a fake HOME with `~/.openclaw/openclaw.json`; first run of `muster onboard`.
- **Action:** open onboarding.
- **Expected result:** the detect step shows `Found an openclaw setup: 3 skills, 2 channels, memory — bring it over?` (sources are named by their command id) with keys `r` review and `k` skip. Review opens the same plan as 26-1A. Skip writes nothing.
- **Test:** `packages/cli/test/onboarding-v2.test.ts` › "onboarding offers migration when another agent setup is found"
- **Environment:** fake HOME.
- **Known gaps:** none.
- **Evidence:** test run 2026-11-14: the first step shows `Found an openclaw setup: 3 skills, 2 channels, memory — bring it over?` with `r review  k skip`; `r` opens the same plan as the dry run (secret masked), Esc returns, `k` dismisses; after quitting, no `.muster` in the workspace or HOME and the fixture tree hashes are unchanged.
