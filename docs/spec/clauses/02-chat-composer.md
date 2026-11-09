# 02 — Chat composer

How the composer behaves while a turn is running. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-02-1A — Enter during a turn steers it

- **Precondition:** a turn is running on a runtime that can steer (Codex app-server).
- **Action:** type "use uv instead" and press Enter.
- **Expected result:** the text goes into the running turn (no new turn starts); the transcript shows it as a user line marked as sent to the running turn; the composer is empty and stays usable.
- **Test:** `packages/cli/test/chat-composer.test.ts` › "enter during a running turn steers it instead of starting a new turn"
- **Environment:** chat harness, fake runtime.
- **Known gaps:** Claude Code and pi runtimes cannot steer yet; they queue (02-1B).
- **Evidence:** UNVERIFIED

## MUS-SPEC-02-1B — When steering is unavailable the message is queued and runs next

- **Precondition:** a turn is running; the runtime refuses steering.
- **Action:** type "then update the README" and press Enter; the turn ends.
- **Expected result:** while the turn runs, a band above the composer shows the queued message; when the turn ends, it runs as the next turn, in order.
- **Test:** `packages/cli/test/chat-composer.test.ts` › "a message that cannot steer is queued, shown above the composer, and runs after the turn"
- **Environment:** chat harness, fake runtime.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-02-1C — Ctrl+Q queues a follow-up even when steering is possible

- **Precondition:** a turn is running on a runtime that can steer.
- **Action:** type "next: write the changelog" and press Ctrl+Q (Alt+Enter does the same).
- **Expected result:** nothing is steered; the message is queued and runs after the turn.
- **Test:** `packages/cli/test/chat-composer.test.ts` › "ctrl+q queues a follow-up without steering"
- **Environment:** chat harness.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-02-1D — Interrupting returns queued messages to the composer

- **Precondition:** a turn is running with one queued message.
- **Action:** press Esc.
- **Expected result:** the turn is interrupted; the queued text is back in the composer for editing; nothing runs automatically.
- **Test:** `packages/cli/test/chat-composer.test.ts` › "esc interrupts and puts queued messages back in the composer"
- **Environment:** chat harness.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-02-1E — Alt+Up edits the last queued message

- **Precondition:** a turn is running with two queued messages and an empty composer.
- **Action:** press Alt+Up.
- **Expected result:** the last queued message leaves the queue and fills the composer; the first stays queued.
- **Test:** `packages/cli/test/chat-composer.test.ts` › "alt+up pulls the last queued message back into the composer"
- **Environment:** chat harness.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED
