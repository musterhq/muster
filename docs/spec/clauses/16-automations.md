# 16 — Automations: reminders and routines that run themselves

A job is a **reminder** (deliver a fixed message, no model call) or a **run** (send a prompt through the runtime and deliver its answer). It fires once (`at`: an ISO time or `in 5m` / `in 2h` / `in 1d`) or on a cron (optionally in a time zone). A tick — `muster daemon`, an open `muster chat`, or `muster schedule run-due` — runs what is due through the scheduler's at-most-once claims, then delivers to `terminal`, `desktop` or `channel:<id>`. Agents create jobs with the `schedule_manage` tool served by `muster mcp serve`. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-16-1A — "Remind me in 5 minutes" fires exactly once

- **Precondition:** an empty workspace; the clock reads T.
- **Action:** create a reminder `in 5m` "stretch" delivered to `terminal`; tick at T+4m, at T+5m, and again at T+6m.
- **Expected result:** nothing is delivered at T+4m; "stretch" is delivered exactly once at T+5m; the T+6m tick delivers nothing; the job is listed as done with last result `completed`.
- **Test:** `packages/core/test/automations.test.ts` › "a reminder in 5m fires once when the clock reaches it"
- **Environment:** real SQLite scheduler store in a temp dir, injected clock, recording deliverer.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-16-1B — Times are understood or refused

- **Precondition:** clock at a fixed instant.
- **Action:** create reminders with `in 90s`, `in 2h`, `in 1d`, `in 5 minutes`, an ISO time with offset, and with `yesterday`, `in 5 parsecs`, and an ISO time in the past.
- **Expected result:** the first five schedule at exactly now+90 s, now+2 h, now+1 d, now+5 min and the ISO instant; the others are refused with a message that names accepted forms (past times say they are in the past).
- **Test:** `packages/core/test/automations.test.ts` › "relative and ISO times are parsed and nonsense is refused"
- **Environment:** pure, injected clock, temp store.
- **Known gaps:** natural language ("tomorrow at 9") is not parsed; agents convert it to ISO.
- **Evidence:** UNVERIFIED

## MUS-SPEC-16-1C — Cron in a time zone

- **Precondition:** clock at 2026-11-09T00:00:00Z.
- **Action:** create a routine `0 9 * * *` with time zone `Asia/Kolkata`; create one with time zone `Mars/Olympus`.
- **Expected result:** the first's next run is 2026-11-09T03:30:00Z (09:00 in Kolkata); the second is refused as an unknown time zone.
- **Test:** `packages/core/test/automations.test.ts` › "cron routines honour a time zone"
- **Environment:** Intl time-zone data of the running Node.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-16-2A — Two ticks at once never double-deliver

- **Precondition:** a reminder that is already due.
- **Action:** start two `muster daemon --once` processes at the same moment against the same workspace.
- **Expected result:** across both processes' output the reminder is delivered exactly once.
- **Test:** `packages/cli/test/automations-cli.test.ts` › "two daemons ticking at once deliver a due reminder once"
- **Environment:** the real CLI as two child processes sharing one SQLite file.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-16-2B — Missed runs catch up once

- **Precondition:** a routine every 5 minutes and a one-off reminder, both due an hour ago (the machine was asleep).
- **Action:** tick once, then tick again a few seconds later.
- **Expected result:** the first tick runs the routine once (not twelve times) and delivers the late reminder once; the second tick runs nothing; the routine's next run is in the future.
- **Test:** `packages/core/test/automations.test.ts` › "missed runs catch up once, not in a burst"
- **Environment:** temp store, injected clock.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-16-2C — The daemon ticks, prints one line per run, and stops cleanly

- **Precondition:** a due reminder delivered to `terminal`; no chat is open.
- **Action:** run `muster daemon --interval 1`; once its line appears send SIGTERM.
- **Expected result:** stdout has one line naming the job id and "stretch"; the process exits 0 after SIGTERM and says it stopped.
- **Test:** `packages/cli/test/automations-cli.test.ts` › "muster daemon delivers due reminders and stops on SIGTERM"
- **Environment:** the real CLI as a child process.
- **Known gaps:** launchd/systemd units are documented in `muster daemon --help`, not installed.
- **Evidence:** UNVERIFIED

## MUS-SPEC-16-3A — Desktop notifications never go through a shell

- **Precondition:** a desktop reminder whose message is `"; rm -rf ~ #` and `$(whoami)`.
- **Action:** deliver it on macOS and on Linux with a recording process launcher.
- **Expected result:** macOS runs `osascript` and Linux runs `notify-send`, each with the title and message as separate argv entries, verbatim; no shell is involved and no argument contains the message spliced into script source.
- **Test:** `packages/core/test/automations.test.ts` › "desktop delivery passes the message as an argument, never as script"
- **Environment:** injected launcher (no real notification in CI).
- **Known gaps:** Windows has no desktop deliverer yet (reported as not supported).
- **Evidence:** UNVERIFIED

## MUS-SPEC-16-3B — Channel delivery says when it is not wired

- **Precondition:** a due reminder delivered to `channel:telegram-main`; no channel sender is configured.
- **Action:** tick.
- **Expected result:** the run is recorded `failed` with "channel delivery not configured (telegram-main)"; the listing shows that result; with a channel sender supplied the same job delivers to it.
- **Test:** `packages/core/test/automations.test.ts` › "channel delivery reports not configured until a sender exists"
- **Environment:** temp store, injected clock.
- **Known gaps:** the gateway's outbound send path is not wired to automations yet.
- **Evidence:** UNVERIFIED

## MUS-SPEC-16-3C — A reminder appears as a card in the open chat

- **Precondition:** a chat is open (its presence is recorded); a reminder `in 5m` to `terminal`.
- **Action:** a daemon tick and the chat's tick both run at T+5m.
- **Expected result:** the daemon leaves the terminal reminder to the chat; the chat's transcript shows one reminder card with the message; ticking again adds nothing.
- **Test:** `packages/cli/test/automations-chat.test.ts` › "an open chat shows a due reminder as a card, once"
- **Environment:** chat harness transcript, real store, injected clock.
- **Known gaps:** `run` jobs are left to the daemon; the chat only fires reminders.
- **Evidence:** UNVERIFIED

## MUS-SPEC-16-4A — Agents set reminders through `schedule_manage`

- **Precondition:** an initialized workspace.
- **Action:** over a real `muster mcp serve`, list tools, call `schedule_manage` create `{action: create, kind: reminder, when: "in 5 minutes", message: "stretch"}`, then list, then remove.
- **Expected result:** the tool is listed with a schema; create echoes the id, kind, message, exact ISO time and delivery; list shows it; remove confirms; list is empty.
- **Test:** `packages/cli/test/mcp-serve.test.ts` › "an agent sets, lists and removes a reminder over MCP"
- **Environment:** the real CLI as a child process.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-16-4B — Agent scheduling is governed

- **Precondition:** an initialized workspace.
- **Action:** create a reminder with a 2,000-character message; create active jobs up to the cap and one more.
- **Expected result:** the long message is refused naming the 500-character limit; the job past the cap is refused naming the 20-job limit; nothing extra is stored.
- **Test:** `packages/core/test/automations.test.ts` › "schedule_manage caps message length and active jobs"
- **Environment:** tool registry with a temp workspace.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-16-5A — An automations table in the CLI and chat

- **Precondition:** one cron routine and one done reminder.
- **Action:** `muster schedule list`; `/schedule list` and `/remind in 10m drink water` in chat.
- **Expected result:** a table with the columns ID, KIND, NEXT RUN, LAST RUN, RESULT, ENABLED shows both jobs (done reminder shows `done`); `/remind` echoes what was scheduled and the job appears in `/schedule list`.
- **Test:** `packages/cli/test/automations-cli.test.ts` › "muster schedule list prints the automations table" and `packages/cli/test/automations-chat.test.ts` › "/remind schedules and /schedule list shows it"
- **Environment:** real CLI child process; chat slash handler with real store.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED
