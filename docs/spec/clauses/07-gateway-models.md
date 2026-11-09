# 07 — Models behind a gateway (Codex model providers)

A Codex model provider defined in `~/.codex/config.toml` (`[model_providers.<id>]`, for example an OpenAI-compatible router such as OmniRoute) can drive `muster chat` turns with Codex's full tool loop. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-07-1A — A run can pick a Codex model provider

- **Precondition:** runtime `codex` (app-server transport).
- **Action:** run a turn with `codexModelProvider: "hybrow"` and model `auto/gpt`.
- **Expected result:** the app-server is started with `model_provider="hybrow"` and `model="auto/gpt"`; a later turn with a different provider does not reuse that warm process.
- **Test:** `packages/core/test/gateway-models.test.ts` › "codex turns run on the chosen model provider and do not share warm sessions across providers"
- **Environment:** fake app-server binary via `MUSTER_CODEX_COMMAND`.
- **Known gaps:** the `codex exec` fallback passes the same override.
- **Evidence:** UNVERIFIED

## MUS-SPEC-07-1B — `/model <provider>:<model>` in chat selects a gateway model

- **Precondition:** `~/.codex/config.toml` defines `[model_providers.hybrow]`.
- **Action:** in `muster chat`, run `/model hybrow:auto/gpt`, then send a prompt.
- **Expected result:** the turn runs on the Codex runtime with that provider and model. On the Codex runtime, a `name:model` whose `name` is not a configured Codex provider is refused with the list of known providers (model ids that merely contain a colon, like `llama3.1:8b`, are left alone on other runtimes).
- **Test:** `packages/cli/test/gateway-model-command.test.ts` › "--model provider:model runs on the gateway provider and unknown providers are refused"
- **Environment:** `muster chat --model … "prompt"` one-shot with a temp CODEX_HOME holding the provider table and a fake `codex` (exec transport).
- **Known gaps:** the picker does not list gateway models yet; type them.
- **Evidence:** UNVERIFIED

## MUS-SPEC-07-2A — The model picker lists the models Codex offers today

- **Precondition:** Codex is installed and logged in; its `model/list` returns `gpt-7-test` and `gpt-7-mini-test`.
- **Action:** open the model picker (`/model` with no argument).
- **Expected result:** the list shows `gpt-7-test` and `gpt-7-mini-test`, not Muster's built-in fallback names; when `model/list` fails, the fallback list is shown instead of nothing.
- **Test:** `packages/cli/test/gateway-model-command.test.ts` › "the model picker lists Codex's live models and falls back when Codex cannot list them"
- **Environment:** `muster chat "/model"` one-shot with a fake `codex` first on PATH.
- **Known gaps:** gateway (`[model_providers.*]`) models are typed as `provider:model`; they are not listed.
- **Evidence:** UNVERIFIED
