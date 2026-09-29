# Changelog

All notable changes to Muster are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
semantic versioning.

## [Unreleased]

### Added
- Codex app-server lifecycle budgets (`CODEX_RUN_LIFECYCLE_VERSION`): independent request, idle, and absolute turn budgets, cancellation, thread/turn identity callbacks, and a `dispatchState` classification on run results. Callers that omit `budgets` keep the previous behaviour.
- Hindsight client (`core/src/hindsight.ts`) and a SQLite-backed durable scheduler store with one-shot import of legacy `schedules.json`.

### Fixed
- Scheduler database startup no longer fails with `SQLITE_BUSY` when several processes open a fresh database at once (`busy_timeout` is now set before the WAL pragma).
- A lost `turn/start` acknowledgement (timeout or app-server exit) is no longer fallback-eligible, so a turn the provider may have accepted is never replayed. This is an intended behaviour change for all callers.
- Keep-alive sessions resume notification observation even when a turn throws.

## [0.1.11] - 2026-07-08

Muster 0.1.11 is the Frappe-aware interaction release. It adds a lightweight,
permission-sensitive chat command layer for enterprise channels and a Frappe
interaction planner that guides CRUD/report workflows without sending every
control question through the provider.

### Added
- Added gateway-level interaction cards for `/help`, `/start`, `/status`,
  `/whoami`, `/tools`, `/reports`, `/tokens`, `/limits`, `/security`, `/evals`,
  `/index`, and `/settings`, all without a `/muster` prefix.
- Added Frappe User/Employee/role-aware command rendering so paired Slack,
  Telegram, Google Chat, Teams, Discord, WhatsApp, and web senders see identity,
  tool, report, security, and governance controls scoped to their resolved
  Frappe context.
- Added `frappe_chat_interaction_plan` to the Frappe capability pack for humane
  guided CRUD/report UX: mandatory-field prompts, property-setter awareness,
  preview-before-write safety, table/report next actions, and Frappe document
  links.
- Added CLI control views for the new enterprise surfaces so terminal users can
  inspect identity, reports, rate limits, security, eval, indexing, and response
  settings without knowing implementation details.

### Changed
- Moved channel built-in help/status UX from product-branded command lists to
  generic enterprise controls that can be used naturally inside each connected
  chat surface.
- Kept Frappe as the authorization authority: the new interaction planner
  prepares and explains actions, while permission checks and writes remain gated
  by the existing Frappe safe-write flow.

### Fixed
- Prevented channel slash-command UX from implying a separate `/muster` command
  namespace where the connected Frappe/channel context already determines which
  tools and controls are available.
- Added regression coverage for gateway command rendering, Frappe interaction
  planning, and TUI command/control surfaces.

## [0.1.10] - 2026-07-05

Muster 0.1.10 is the roster and integration-depth patch release. It turns the
new integration catalog work into a production-grade release boundary, with
explicit support depth, safer MCP activation, and artifact workflow verification
kept separate from the earlier channel readiness train.

### Added
- Added Roster support-depth summaries across owned packs, channel adapters,
  installable MCPs, host reuse, setup-plan-only entries, auth mode, source, risk,
  and support class so integration gaps are visible before activation.
- Added release-gate QA for roster support depth inside the channel/plugin setup
  scorecard, including persisted roster matrix evidence in `catalog.json`.
- Added `muster artifacts contract` and `muster artifacts verify` surfaces so
  Office/PDF artifact workflows expose their contract, structural verifier, and
  publish blockers directly from the CLI and integration workflow.

### Changed
- Hardened MCP activation so env-backed install specs validate required env vars
  without writing raw secret values into `.muster/config.json`.
- Resolved MCP stdio env and argument references at process start, preserving the
  filtered-env boundary while keeping GitHub, Linear, Firecrawl, n8n, Postgres,
  and other env-backed MCPs functional.
- Reused the core roster MCP install resolver from onboarding so CLI and TUI
  setup paths cannot drift or persist secrets differently.
- Updated Artifact Studio integration guidance to run a real verified DOCX sample
  and advertise artifact-specific next steps instead of generic plugin checks.

### Fixed
- Kept Telegram, Slack, and gateway behavior covered through the full gateway
  regression suite while merging the roster/MCP/artifact release pass.
- Fixed artifact-studio capability-loader expectations so declaration and
  provider-led document workflow tools are treated as first-class exported tools.

## [0.1.9] - 2026-06-29

Muster 0.1.9 is the Office artifacts and integration-readiness point release.
It strengthens the document/PPT/PDF/Excel pillar, improves daily-life channel
readiness, and makes the public website/npm discovery surface easier to trust
before the next heavier workflow release.

### Added
- Added governed first-party flow tool execution so saved flows can run audited
  core tools, while shell execution remains opt-in behind `--toolset full` and
  explicit command allowlists.
- Added session-continuity metadata for searchable chat history so resumed
  sessions expose the active backend, latest session id, and recall path instead
  of hiding continuity state.
- Added integration readiness summaries covering catalog coverage, channel
  setup, plugin enablement, MCP configuration, top blockers, and daily-life pack
  next steps.
- Added all-channel doctor output for Telegram, Slack, Google Chat, Discord,
  WhatsApp, Teams, and web embed operators with missing setup, auth mode, reply
  mode, guardrails, and next commands.
- Added `muster gateway status` and cold-start channel status guidance so users
  can inspect gateway/channel readiness without initializing or exposing bearer
  tokens.
- Added personal-agent dashboard readiness lines so `muster dashboard status`
  shows packs, channels, MCPs, memory health, token ledger state, sessions, and
  concrete next setup commands.
- Added Artifact Studio builders for DOCX, XLSX, PPTX, and simple PDF outputs,
  plus app-server handoff planning for higher-fidelity document, spreadsheet,
  presentation, and PDF workflows when a Codex or Claude host exposes those
  artifact skills.
- Added gated Office artifact workflows with tool integration discovery,
  deterministic draft generation, structural verification, optional app-server
  polish, approval-gated publish/share steps, and goal-loop passes for
  design/build/verify/polish/deliver/learn cycles.
- Added `muster artifacts plan` and `muster artifacts create` so users can see
  the gated workflow and create local DOCX/XLSX/PPTX/PDF artifacts without
  knowing the underlying capability-pack tool names.
- Added chat capability checks and richer slash-picker matching so prompts or
  commands mentioning skills, plugins, MCPs, channels, or Office artifact terms
  surface concrete setup/status guidance instead of silently relying on memory.
- Added guide pages for agent harness basics, MCP token visibility, Frappe AI
  with DocType-aware retrieval, and governed memory for long-running agents.
- Added launch and backlink playbook with Search Console checks, GitHub/npm
  metadata instructions, and publish-ready LinkedIn, X, Hacker News, Frappe
  Forum, and Reddit drafts.

### Changed
- Tightened release/demo evidence around integrations: the dashboard now gives a
  compact cockpit view, while `muster integrations status` remains the deeper
  readiness matrix for catalog and setup blockers.
- Updated homepage SEO metadata and exact-query language around "Muster agent
  harness", governed agent harness, MCP agent harness, Frappe / ERPNext agent
  harness, and production AI agents.
- Updated public package metadata to use `https://themuster.dev` as homepage and
  stronger discovery keywords for agent harness, MCP, scoped memory, token
  ledger, browser automation, Frappe, and ERPNext.
- Expanded sitemap and `llms.txt` to include guide and integration landing
  pages.

## [0.1.9] - 2026-07-01

Muster 0.1.9 deepens channel/operator setup and hardens live adapter behavior
for Telegram, Slack, Google Chat, Discord, WhatsApp, Teams, and web embeds.

### Added
- Added `muster channels ready <channel>` as the single-command channel setup
  path: it initializes gateway config, stores credentials without echoing
  secrets, runs channel doctor checks, starts or prints the daemon command, and
  runs a local sample simulation.
- Added background gateway daemon management with
  `muster gateway daemon start|stop|status|restart`, including Telegram
  long-poll support through `--with-telegram-poll`.
- Added explicit Telegram webhook registration as an advanced opt-in command:
  `muster gateway webhook telegram --public-url https://...`.
- Added delivery idempotency for adapter retries so Slack, Discord, WhatsApp,
  Google Chat, Teams, and Telegram retries do not double-send replies or spend
  tokens twice after successful processing.

### Changed
- Telegram setup now defaults to Hermes/OpenClaw-style background long polling:
  a bot name and bot token are enough for the normal path; public HTTPS
  webhooks are optional.
- Channel catalogs, plugin setup guidance, integration workflows, and capability
  packs now point users to `muster channels ready ...` instead of a multi-step
  manual setup path.
- Slack, Google Chat, Discord, WhatsApp, and Teams setup guidance now states the
  exact required credentials and keeps the current adapter scope honest.

### Fixed
- Google Chat and Teams authentication failures now return HTTP 401 instead of
  generic server errors.
- WhatsApp POST webhooks require and verify Meta app-secret signatures when
  configured, with tests covering unsigned and signed requests.
- Slack and WhatsApp retry deliveries are cached after platform auth so
  duplicate platform retries do not duplicate outbound sends.

## [0.1.8] - 2026-06-27

Muster 0.1.8 is a release-proof patch for the public npm path.

### Fixed
- Aligned `muster benchmark` with the canonical benchmark scenario generator so
  the CLI, README, website, and `benchmark/RESULTS.md` report the same
  deterministic Token Waste Index values.
- Updated package README quick-start/proof text so the npm package page uses
  the verified pnpm command form and current benchmark numbers.

## [0.1.7] - 2026-06-27

Muster 0.1.7 is the public demo and positioning release. It makes the first
GitHub/npm experience clearer, safer to try, and easier to share.

### Added
- README and website positioning around Muster as an open-source governed agent
  harness for production AI systems.
- Public demo assets, social preview assets, and a terminal demo GIF for the
  README and website.
- Channel/plugin readiness diagnostics in the CLI so integration setup can
  report concrete missing prerequisites.

### Changed
- README quick start now starts with the deterministic no-key demo:
  `pnpm --package=@musterhq/cli dlx muster demo`.
- Website hero now leads with the governed-agent wedge, a "Run the demo" CTA,
  and concise proof instead of a dense capability list.
- Website SEO/social metadata now includes clearer descriptions and preview
  imagery for shared links.
- Package versions are aligned for the next npm publication.

### Fixed
- Replaced the broken `pnpm dlx @musterhq/cli demo` command form with the
  verified pnpm syntax for packages that expose multiple binaries.
- Restored near-top Token Waste Index proof in the README so visitors see
  deterministic token-savings evidence before long explanations.

## [0.1.6] - 2026-06-23

Muster 0.1.6 is the integration and CLI usability release. It moves Muster
closer to being a practical agent harness people can run directly from the
terminal or connect behind product/chat surfaces.

### Added
- **Interactive terminal chat overhaul**: `muster` now opens a focused TUI chat
  surface with slash-command and `@agent` completion, command pickers, session
  naming/resume, provider/model selection flows, token/status commands, and a
  cleaner site-aligned palette.
- **Capability-pack catalog expansion**: all built-in plugin rows now resolve to
  real capability packs instead of policy-only placeholders. The catalog covers
  developer tools, browser QA, web frameworks, research, artifacts, data,
  security, daily ops, channels, providers, Codex, Claude Code, and MCP bridge
  workflows.
- **Provider setup packs** for OpenAI, Anthropic/Claude, vLLM, and
  Codex/Claude CLI runtimes with setup guidance, readiness checks, model-policy
  hints, and latency triage.
- **Auth-heavy MCP setup workflows** for GitHub, Notion, Linear, Google Drive,
  Firecrawl, Postgres, and n8n, including env readiness, OAuth setup/import
  paths, installability checks, and safe default tool policies.
- **Built-in channel packs** for Slack, Google Chat, Discord, WhatsApp, Teams,
  and Telegram. Telegram remains optional for regions where it is unavailable.
- **Web framework pack** for Frappe/ERPNext, React, Vue, Vite, Nuxt, and common
  web stacks, with local/dev/build/deploy/integration runbooks and production
  readiness checks.
- **Indexed scoped memory retrieval** using SQLite/FTS so long-running personal
  and project memory stays fast as conversations grow.
- **Token ledger visibility** in CLI flows so model spend, replay waste, and
  skill attribution are inspectable instead of hidden.
- **Latency probe command**: `muster latency "prompt" --runs 3` separates
  provider time from Muster overhead, reports p50/p95, and flags whether a slow
  turn is provider-bound or caused by recall/prompt/persistence overhead.
- **Local workspace-read fast path**: trivial prompts that only ask to list the
  current folder are answered by Muster directly with an audited
  `muster-local/workspace-read` episode, avoiding unnecessary Codex round trips.
- **Source-backed integration catalog expansion**: `muster plugins catalog` now
  exposes 116 built-in entries after checking current Hermes and OpenClaw
  source trees. New setup-plan surfaces cover additional providers, channels,
  voice, document extraction, file transfer, webhooks, policy, token/cost
  governance, diagnostics, QA, migration, and memory backends without
  overclaiming execution before a pack/MCP is wired.

### Changed
- `muster plugins setup/check/enable` now reports concrete prerequisites:
  missing env vars, setup URLs, MCP/channel availability, configured defaults,
  capability-pack readiness, and next commands.
- Runtime/provider UX is now picker-oriented: users can switch provider, model,
  runtime, MCPs, plugins, and skills from inside chat instead of memorizing
  exact IDs.
- Chat `fast` mode now means a warm native session with lighter Muster context
  rather than a cold one-shot Codex exec path, so repeat Codex turns can reuse
  app-server state while skipping recall, ambient skill scoring, and memory
  writes.
- Codex and Claude Code are modeled as first-class runtime capability packs,
  matching the way Hermes treats autonomous agent CLIs while preserving Muster's
  own session, memory, and token accounting.
- Browser and web-search workflows now prefer explicit MCP setup and cited
  source paths over hidden provider behavior.
- Default runtime guidance now uses Codex CLI instead of accidental localhost
  endpoints, keeping fast self-hosted providers opt-in rather than accidental.

### Fixed
- Serialized warm Codex app-server turns per session and added injected-context
  hashes to native session handles, preventing concurrent turn event mixing and
  stale memory/skill/rule reuse across resumed provider sessions.
- Native session reuse now hashes stable instructions separately from volatile
  per-turn recall/skill context, preventing ordinary memory changes from
  cold-starting a fresh Codex app-server session.
- Native Codex and Claude Code attempts now stamp actual `create`/`continue`
  session mode and session id into the token ledger, so replay-waste warnings
  catch bloated continued Codex sessions instead of only Pi/API paths.
- Removed the “pack=no” gap from the built-in plugin catalog.
- Fixed CLI setup output so release-critical integrations show real setup links
  and readiness state rather than vague availability text.
- Hardened OAuth/MCP setup paths so credentials are checked and never printed in
  CLI output.

## [0.1.0] - 2026-06-12

First feature-complete core. Not yet 1.0: APIs may shift before stabilization.

### Added
- **Run loop** with scoped-memory recall, agent operating rules, and governed
  model fallback recorded as evidence (never silent drift).
- **Scoped memory** lanes (tenant/workspace/user/pairing/session/role/persona)
  with leak-prevention enforced by tests.
- **Token ledger** with replay-waste detection and CLI tables (`muster tokens`).
- **`muster verify`** — store integrity: corruption, duplicate run ids, silent
  model drift, stale-narrative poisoning.
- **`muster evolve`** — recursive eval loop with evidence-aware adjudication.
- **Flow engine** — tool/agent/gate steps, preflight, durable runs, replay/diff,
  `flow loop --cron`.
- **Eval-gated skill loop** — candidates promote only through a converged suite.
- **Context renderer** — immutable transcripts with progressive tool-result
  stubbing (large token savings on long sessions).
- **SQLite session store** + four-shape `session_search` (FTS5).
- **Never-wedge compactor** — a session can always take a turn.
- **Pulse scheduler** — preflight-gated heartbeat with a daily token budget.
- **Pull-based subagents** — durable run store, exactly-once result claims.
- **MCP client** — per-server isolation, circuit breakers, capped results.
- **Surface gateway** — one governed envelope for Telegram, Slack, Discord,
  WhatsApp, Google Chat, and Teams, plus a zero-dependency web client.
- **JSON-RPC gateway protocol** — one transport for CLI/desktop/web.
- **Tool registry v2**, **profiles v2**, **typed hook bus**, **capability-pack
  loader**, and a **20-provider preset catalog**.
- **`muster demo`** — provisions a throwaway workspace and stub model service.
