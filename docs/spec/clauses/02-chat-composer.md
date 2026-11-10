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

## MUS-SPEC-02-2A — The slash menu shows each setting's current value and never cuts a hint mid-word

- **Precondition:** chat with model `gpt-6.1-terra`, effort High, live diff on.
- **Action:** type `/` (scripts: `muster chat --complete "/" --describe`).
- **Expected result:** the `/model` row's description starts with the current value (`gpt-6.1-terra · High`), `/live-diff` with `on`; the label is the command plus at most a short argument hint that ends at a word or bracket boundary (no `[auto|low|medium|hi`).
- **Test:** `packages/cli/test/gateway-model-command.test.ts` › "the slash menu shows current values and whole argument hints"
- **Environment:** real CLI, `--complete --describe`.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-02-1F — Ctrl+C interrupts first and quits only on a second press

- **Precondition:** chat; a turn is running and the composer holds a draft.
- **Action:** press Ctrl+C; press Ctrl+C again within 2 s. Separately: with no turn running, press Ctrl+C once with an empty composer, and once with text in the composer.
- **Expected result:** the first press interrupts the turn like Esc (the chat stays open, the draft stays in the composer, a dim hint says Ctrl+C again quits); the second press within 2 s quits. When idle, Ctrl+C on an empty composer quits at once; with text, the first press clears the composer and a second press within 2 s quits.
- **Test:** `packages/cli/test/chat-composer.test.ts` › "ctrl+c interrupts a running turn and only a second press quits"
- **Environment:** chat harness, fake runtime.
- **Known gaps:** the 2 s window uses the wall clock; it is not tested past expiry.
- **Evidence:** UNVERIFIED

## MUS-SPEC-02-2B — Pickers cover the full width, under a rule

- **Precondition:** a 110-column chat; `/model` (or `/rewind`) opens a picker above the composer.
- **Action:** compute the picker's placement and render it.
- **Expected result:** the picker is 110 columns wide with no right margin, so no cell of the row behind it (a stray `─` at column 110) shows through; its first row is a dim full-width rule that separates it from the transcript; keys still reach the list.
- **Test:** `packages/cli/test/chat-composer.test.ts` › "composer pickers cover every column and open under a rule"
- **Environment:** pure placement function and wrapper component.
- **Known gaps:** none.
- **Evidence:** live, 2026-11-10: `/model` and `/rewind` pickers open under a full-width rule; no row of the picker has a stray `─` at column 110. Red→green: chat-composer.test.ts.

## MUS-SPEC-02-2C — `/shortcuts` lists every key, and help columns line up

- **Precondition:** chat.
- **Action:** `/shortcuts`; `/help`.
- **Expected result:** `/shortcuts` lists every chat key: Enter (send, or steer a running turn), Ctrl+Q / Alt+Enter (queue), Alt+↑ (edit queued), Esc (stop the turn), Ctrl+C (interrupt, twice to quit), Ctrl+O (expand output), Ctrl+D (live file view), PgUp/PgDn (scroll), Tab (complete), `\` at line end, `@agent`. In `/help` and `/shortcuts` every description starts in the same column; a usage wider than that column puts its description on the next row, in the same column.
- **Test:** `packages/cli/test/chat-composer.test.ts` › "/shortcuts lists every chat key and help rows line up" and › "muster chat --shortcuts prints the keys in aligned columns" (the panel printer used to collapse the padding to one space)
- **Environment:** pure list and row formatter.
- **Known gaps:** none.
- **Evidence:** live, 2026-11-10: `/shortcuts` lists 11 keys and `/help` descriptions start in one column. The CLI test went red on the panel printer collapsing padding, then green.
