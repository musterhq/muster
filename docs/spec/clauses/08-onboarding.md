# 08 — Onboarding detects, verifies, then saves

`muster onboard` opens on its best guess: it looks at what is already on the machine (Codex and Claude Code logins, `ANTHROPIC_*` / `OPENAI_*` gateways, Codex `[model_providers.<id>]` tables, Ollama and LM Studio on localhost), pre-selects every route that is ready, proves each selected route with one tiny real request before moving on, and ends with an honest "Ready N/M" summary. Credentials are only ever referenced by env var name; their values are never read into the screen, the profile, or an error. Design: `deep-setup-settings.md` sections 4–6, build-order item 1 (issue #148, phase 1). Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-08-1A — Detection finds env gateways, Codex providers and local servers without reading secrets

- **Precondition:** `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL` set; `OPENAI_BASE_URL` + `OPENAI_API_KEY` set; `$CODEX_HOME/config.toml` defines `[model_providers.hybrow]`; Codex is installed and logged in; Ollama answers `/api/tags` with one model; LM Studio is not running.
- **Action:** run `detectProviders` with that environment, then render the model step from its result.
- **Expected result:** routes `anthropic-proxy` ("Anthropic-compatible proxy", pill `key ref`, key referenced as `ANTHROPIC_AUTH_TOKEN`, model from `ANTHROPIC_MODEL`), `openai` (`key ref`, base URL from `OPENAI_BASE_URL`), `codex-provider:hybrow`, and `ollama` (`running`, its model) are found; LM Studio is absent; neither secret value appears anywhere in the detection result or on the rendered screen.
- **Test:** `packages/cli/test/onboarding-v2.test.ts` › "detection finds env gateways, Codex model providers and local servers and never holds a secret value"
- **Environment:** injected env, home, `exists`, `run`, `fetch`; temp `CODEX_HOME`.
- **Known gaps:** `~/.openclaw`, `~/.hermes`, `~/.omp` and inherited MCP/skills are not detected yet (phase 2).
- **Evidence:** UNVERIFIED

## MUS-SPEC-08-1B — A hung local port never stalls detection

- **Precondition:** the Ollama and LM Studio ports accept the request but never answer.
- **Action:** run `detectProviders`.
- **Expected result:** detection finishes in well under two seconds and lists neither local server.
- **Test:** `packages/cli/test/onboarding-v2.test.ts` › "a local server that never answers does not stall detection"
- **Environment:** injected `fetch` that never resolves.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-08-2A — The model step opens on the detected routes, ready ones pre-selected

- **Precondition:** detection reports Codex logged in, Claude Code logged in, an Anthropic-compatible proxy with a key reference, and no OpenAI key.
- **Action:** start interactive onboarding and press Enter twice to reach the model step.
- **Expected result:** one row per route with its status pill (`logged in`, `key ref`, `no key`); Codex, Claude Code and the proxy are ticked, OpenAI is not; no "configure later: codex login" / "claude login" advice is shown for the routes that are already ready.
- **Test:** `packages/cli/test/onboarding-v2.test.ts` › "the model step lists detected routes with status pills and ticks the ready ones"
- **Environment:** `runMusterOnboardingTui` with fake TTY streams and injected `detect`.
- **Known gaps:** local servers (Ollama, LM Studio) are listed but not pre-selected, because verifying them loads a model into memory.
- **Evidence:** UNVERIFIED

## MUS-SPEC-08-3A — Leaving the model step verifies every selected route in parallel and shows the real result

- **Precondition:** the model step from 08-2A; the verifier answers Codex in 1.9 s, the proxy in 2.4 s on `cc/claude-sonnet-5-5`, and fails Claude Code with "Invalid API key · Please run /login".
- **Action:** press Enter on the model step; then `e`, Enter, and `k`.
- **Expected result:** all three checks are in flight at once; the screen shows `✓ Codex · replied in 1.9 s`, `✓ Anthropic-compatible proxy · cc/claude-sonnet-5-5 · replied in 2.4 s` and `✗ Claude Code · Invalid API key · Please run /login` with `e Edit` and `k Skip`. `e` returns to the route list without results; Enter re-verifies; `k` skips the failed route (it is no longer selected) and moves to the next step.
- **Test:** `packages/cli/test/onboarding-v2.test.ts` › "leaving the model step verifies selected routes in parallel and offers edit or skip on failure"
- **Environment:** injected `detect` and `verify`.
- **Known gaps:** "Edit" returns to the list; there is no inline key or URL editor yet (phase 2: Add provider…).
- **Evidence:** real run 2026-11-09, `muster onboard` in tmux on the founder laptop: ✓ Codex 8.5 s, ✓ Claude Code 3.0 s, ✓ Anthropic-compatible proxy 1.4 s, ✓ Codex provider hybrow 8.0 s, ✗ OpenAI API · no key — OPENAI_API_KEY is not set (`~/.muster-work/review/screens/onboarding-v2/after-04-verify-one-failure.png`).

## MUS-SPEC-08-3B — A route that failed verification is never saved as the default

- **Precondition:** Codex and the proxy are ready; Codex fails verification, the proxy replies.
- **Action:** walk onboarding to the finish screen and press Enter to save.
- **Expected result:** the workspace config's default runtime uses the proxy (`anthropic-proxy`, base URL and `ANTHROPIC_AUTH_TOKEN` as a reference, its model), not Codex; the profile records `defaultRoute: "anthropic-proxy"` and the Codex failure. When every route fails, onboarding writes no default route at all.
- **Test:** `packages/cli/test/onboarding-v2.test.ts` › "a route that failed verification is never saved as the default"
- **Environment:** injected `detect` and `verify`; temp workspace and onboarding home.
- **Known gaps:** a verified Claude Code login is not written as the config default (chat reaches it with `/runtime claude-code`); the default stays on the next verified route.
- **Evidence:** UNVERIFIED

## MUS-SPEC-08-3C — `muster onboard --preview --verify` makes real requests and shows real errors

- **Precondition:** a fake `codex` that answers, a fake `claude` that fails with "Invalid API key · Please run /login", and a local Anthropic-compatible server behind `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`.
- **Action:** run `muster onboard --preview --step provider --verify --no-color`.
- **Expected result:** the output shows `✓ Codex · replied in`, `✓ Anthropic-compatible proxy · <model> · replied in` and `✗ Claude Code · Invalid API key`; the server received exactly one small `/v1/messages` request carrying the referenced token; the token never appears in the output.
- **Test:** `packages/cli/test/onboarding-v2.test.ts` › "onboard --preview --verify runs one real request per route and never prints the key"
- **Environment:** CLI subprocess with temp HOME/CODEX_HOME, fake binaries first on PATH, in-process HTTP server.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-08-4A — The finish screen is an honest capability summary

- **Precondition:** the flow from 08-3B (Codex failed, proxy verified) with Slack picked on the channels step.
- **Action:** reach the finish screen.
- **Expected result:** a `Ready 3/5` headline; `✓ chat · default route Anthropic-compatible proxy`; `✓ Anthropic-compatible proxy · replied in 2.4 s`; `✗ Codex` with its error and `fix: codex login`; `✓ memory (ask)`; `✗ Slack` with `fix: muster channels setup slack --bot-token-env SLACK_BOT_TOKEN --app-token-env SLACK_APP_TOKEN`. The old "It knows what to remember…" claim is gone.
- **Test:** `packages/cli/test/onboarding-v2.test.ts` › "the finish screen counts ready capabilities and names the exact fix for each missing one"
- **Environment:** injected `detect` and `verify`.
- **Known gaps:** integrations and channels are not verified in phase 1, so they always count as missing until their own setup command runs.
- **Evidence:** same run: Ready 6/8 with `fix: export OPENAI_API_KEY=<your key>` and the Slack setup command; saved config kept only `apiKeyEnv: ANTHROPIC_AUTH_TOKEN`, no key value (`after-05-finish.png`).

## MUS-SPEC-08-3D — A Codex model provider is verified with a model it serves

- **Precondition:** `$CODEX_HOME/config.toml` has `model = "gpt-6.1-terra"` (served only by OpenAI) and `[model_providers.hybrow]` with `base_url = "https://router.example/v1"`; `ANTHROPIC_BASE_URL=https://router.example` and `ANTHROPIC_MODEL=cc/claude-sonnet-5-5` point at the same gateway. A second provider `gw2` has a Codex profile `[profiles.gw]` with `model_provider = "gw2"` and `model = "auto/gpt"`. A third provider `bare` has neither.
- **Action:** detect, then verify each Codex provider route against a fake `codex` that rejects any model other than the ones each provider serves with "[400]: The 'gpt-6.1-terra' model is not supported".
- **Expected result:** detection gives `codex-provider:hybrow` the model `cc/claude-sonnet-5-5` (same gateway host) and `codex-provider:gw2` the model `auto/gpt` (its profile); verification runs `codex exec -m <that model>` with `model_provider` set and succeeds. For `bare`, the failure says Codex's default model is not served by that provider, and the finish screen's fix is `muster chat --model bare:<model>` with a model it serves — never "check [model_providers.bare] in config.toml". `muster onboard --preview --verify` without `--step` opens on the model step and verifies it, instead of printing step 1.
- **Test:** `packages/cli/test/onboarding-v2.test.ts` › "a Codex model provider is verified with a model it serves, and a rejected default model gets a model fix"
- **Environment:** `detectProviders` with a temp CODEX_HOME; `verifyRoute` with `MUSTER_CODEX_COMMAND` pointing at a fake codex.
- **Known gaps:** without a profile or a same-host env model, Muster cannot know the gateway's model names, so it verifies with Codex's default and explains the fix.
- **Evidence:** UNVERIFIED

## MUS-SPEC-08-4B — A route skipped with `k` is gone from the summary, and the finish screen enables only what was picked

- **Precondition:** detection finds Codex, Claude Code and an Anthropic-compatible proxy, all pre-selected; purpose "Build with code"; no integration picked.
- **Action:** Codex fails verification; press `k` (skip) on the results, then Enter through senses, channels and memory to the finish screen.
- **Expected result:** the finish screen neither lists Codex nor counts it: `Ready 4/4` (chat, Claude Code, proxy, memory). "Will write" enables no plugin or MCP server the user did not pick: no `github` (GitHub was never picked on the senses step), no `codex` / `codex-native-tools` (the Codex route was skipped); `developer-tools` (from the purpose) and `claude-code` stay. A failed route the user leaves with Enter instead of `k` is still listed with its fix (08-4A).
- **Test:** `packages/cli/test/onboarding-v2.test.ts` › "a route skipped with k leaves the summary and the finish screen enables only picks"
- **Environment:** injected `detect` and `verify`, no network.
- **Known gaps:** Codex's own verification time (19.9 s in the QA pass) is the CLI's cold start and is not shortened here.
- **Evidence:** UNVERIFIED
