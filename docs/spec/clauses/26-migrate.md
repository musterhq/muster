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
  - OpenClaw: `openclaw.json` with `channels.telegram.botToken` and `channels.discord`; `workspace/USER.md` and `MEMORY.md`; `skills/figma/SKILL.md`; `cron/jobs.json` with one job; an MCP server.
  - Hermes: `config.yaml`, `memories/MEMORY.md` and `USER.md`, `skills/x/SKILL.md`, `.env`.
  - Claude: `~/.claude.json` mcpServers, `~/.claude/skills/y`, `CLAUDE.md`.
  - Codex: `config.toml` `[mcp_servers.z]`, `AGENTS.md`, `skills/w`.
- **Action:** `muster migrate <source>` for each (dry run), then hash every file under the fake HOME.
- **Expected result:**
  - For each source a plan grouped as Memory / Profile / Skills / MCP servers / Channels / Schedules / Rules. Each item has a short description and its status: `new`, `already in Muster`, or `conflict` (same name, different content).
  - Secrets are shown as `•••• (from openclaw.json channels.telegram.botToken) → set TELEGRAM_BOT_TOKEN`.
  - No file under the fake HOME changed (hashes equal), and nothing was written to Muster.
- **Test:** `packages/cli/test/migrate.test.ts` › "migrate plans each source read-only and never shows a secret"
- **Environment:** a fake HOME with fixtures.
- **Known gaps:** OpenClaw's `memory/main.sqlite` is read through `node:sqlite` read-only (`readOnly: true`); unknown schemas are listed as `skipped: unknown memory schema` rather than guessed.
- **Evidence:** UNVERIFIED

## MUS-SPEC-26-1B — Applying brings items in as Muster-native, with secrets as env references

- **Precondition:** the OpenClaw fixture.
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
- **Evidence:** UNVERIFIED

## MUS-SPEC-26-1C — Conflicts are never overwritten silently

- **Precondition:** Muster already has a skill `figma` with different content, and an MCP server `github` with a different command.
- **Action:** `muster migrate openclaw --apply --yes`.
- **Expected result:** both are reported as conflicts and skipped. `--rename` imports them as `figma-openclaw` and `github-openclaw` instead. Nothing existing is changed.
- **Test:** `packages/cli/test/migrate.test.ts` › "conflicting skills and servers are skipped or renamed, never overwritten"
- **Environment:** as 26-1B.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-26-1D — Undo removes exactly what a migration added

- **Precondition:** a completed `--apply` run R.
- **Action:** `muster migrate undo R`.
- **Expected result:** every item R added is removed: memory entries with R's receipt id, the copied skills, the MCP servers, the channel entries and the automations. Items that existed before R, and items the user edited after R (content hash differs), are kept and listed as `kept: edited after migration`.
- **Test:** `packages/cli/test/migrate.test.ts` › "migrate undo removes only what the run added and keeps later edits"
- **Environment:** as 26-1B.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-26-2A — Onboarding offers migration when it finds another setup

- **Precondition:** a fake HOME with `~/.openclaw/openclaw.json`; first run of `muster onboard`.
- **Action:** open onboarding.
- **Expected result:** the detect step shows `Found an OpenClaw setup: 3 skills, 2 channels, memory — bring it over?` with keys to review or skip. Review opens the same plan as 26-1A. Skip writes nothing.
- **Test:** `packages/cli/test/onboarding-v2.test.ts` › "onboarding offers migration when another agent setup is found"
- **Environment:** fake HOME.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED
