# Contributing to Muster

Muster is a governed agent harness. Contributions are welcome — start small. Muster is one project with [Muster Agent](https://github.com/musterhq/muster-code), the free desktop app built on this core. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules
- **Tests in the same PR.** `pnpm typecheck && pnpm test` must pass before review. A feature without tests is not done.
- **Small, focused PRs.** One concern per PR; merge only on green CI.
- **No new runtime dependencies** without strong justification. The core is intentionally dependency-light (node:http, node:sqlite, pure functions).
- **Everything bundled in one monorepo, one version.** No runtime plugin installation; integrations go through MCP or capability packs.
- **The token ledger touches everything new.** Skills carry receipts, schedulers carry budgets, subagent spend folds into the parent.

## Getting started
```bash
pnpm install
pnpm typecheck && pnpm test
pnpm hc demo          # provisions a throwaway workspace + stub model, runs the full pipeline
```

## Where to look
- `docs/FEATURE_PARITY_PLAN.md` — the roadmap and design rationale.
- `docs/teardowns/` — why each subsystem is built the way it is (and which upstream failure modes it avoids).
- `docs/SDLC_KANBAN.md` — what's done and what's ready.

Good first issues are labeled `good first issue`. Open an issue before large changes so we can align on approach.

## Contribution terms
Contributions are accepted under the repository's [MIT license](LICENSE) (inbound = outbound). There is no CLA and no DCO sign-off.

## Build, typecheck and test
Node 24 and pnpm 10 (`corepack enable`) are required.
```bash
pnpm install --frozen-lockfile
pnpm typecheck        # builds capability-packs/frappe, core and gateway, then typechecks cli and ui
pnpm test             # frappe pack tests, then every workspace package
pnpm build
pnpm --filter @musterhq/core test      # one package while iterating
pnpm test:evidence                     # evidence scripts
```
CI (`Muster CI`, job `validate`) also needs `tmux` for the PTY/TUI evidence run: `qa run pty_tui`.

## Branches and pull requests
1. Open an issue first for anything larger than a small fix.
2. Fork or branch from the latest `main` (`type/short-topic`, e.g. `fix/gateway-retry`).
3. One concern per PR, tests in the same PR, add a `CHANGELOG.md` line under `[Unreleased]` for user-visible changes.
4. Fill in the pull request template (summary, how tested, screenshots for UI).
5. `main` requires a PR and the `validate` check (see [docs/BRANCH_PROTECTION.md](docs/BRANCH_PROTECTION.md)); a maintainer merges.

## Commit style
Short imperative subject (about 72 characters or less) with an optional area prefix, as in the history: `core: steerActiveCodexTurn ...`, `website: ...`. Explain the why in the body. Reference issues with `Fixes #123` / `Refs #123`.

## Releases
Maintainers release `@musterhq/cli` (with `core`, `gateway`, `surface`) to npm: update `CHANGELOG.md` with a `## [x.y.z]` section, then run the **Muster Release** workflow from the Actions tab with the version. It validates, tags `vX.Y.Z`, publishes to npm and creates the GitHub Release from the changelog. Do not bump versions in regular PRs.

## Good first contributions
- Capability packs: tests for the 31 packs that have none, new packs (`capability-packs/`)
- Provider adapters and latency benchmarks
- MCP setup workflows and auth-failure tests
- Frappe/ERPNext packs, eval fixtures and retrieval tests
- Docs, examples, demo recordings and screenshots
- TUI interaction tests and browser automation examples

Labels: `good first issue`, `help wanted`; `type:bug|feature|docs|chore`; `area:core|cli|gateway|packs|mcp|frappe|website`.

## Security
Do not file public issues for vulnerabilities; see [SECURITY.md](SECURITY.md).
