# 05 — The built-in pi runtime can do real work

Muster's embedded pi runtime gets coding tools that match the turn's sandbox, and reports its tool activity like the other runtimes. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-05-1A — In a writable workspace pi can edit files and run commands, and the transcript sees them

- **Precondition:** runtime `pi`, default sandbox (workspace-write); the model writes `hello.txt` and then runs `cat hello.txt`.
- **Action:** run the turn through `executeRun` with an `onToolEvent` listener.
- **Expected result:** `hello.txt` exists with the written content; the listener receives a start and an end for the write and for the command, in order; the command's end carries its output and exit code 0.
- **Test:** `packages/core/test/pi-runtime-tools.test.ts` › "pi turns in a writable workspace edit files, run commands and report tool events"
- **Environment:** pi SDK with pi-ai's faux provider (scripted model), temp workspace and agent dir.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-05-1B — A read-only turn gives pi read tools only

- **Precondition:** runtime `pi`, `nativeSandbox: "read-only"`; the model tries to write `blocked.txt`.
- **Action:** run the turn.
- **Expected result:** the session's active tools are read-only (no `write`, `edit`, `bash`); `blocked.txt` does not exist.
- **Test:** `packages/core/test/pi-runtime-tools.test.ts` › "read-only pi turns cannot write"
- **Environment:** as above.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-05-1C — A missing pi key names the provider and the next step

- **Precondition:** runtime `pi` with no API key in the environment for any pi provider (or for the chosen provider, e.g. `anthropic`).
- **Action:** a turn runs; pi fails with "No API key found for the selected model." (or "… for anthropic.") followed by its own `/login` help.
- **Expected result:** the turn's error says which key is missing and how to fix it in Muster: the env var(s) to set (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … or the chosen provider's own), and `muster pi models` to see which providers are available; pi's `/login` advice (not a Muster command) is dropped. Other errors pass through unchanged.
- **Test:** `packages/core/test/pi-runtime-tools.test.ts` › "a missing pi key names the provider, its env var and the next step" and › "switching to pi warns up front when no pi provider has a key" (`/runtime pi` prints the same hint before the first turn when no pi model is available)
- **Environment:** pure function.
- **Known gaps:** the env var map covers pi's common providers; others get the generic hint.
- **Evidence:** UNVERIFIED
