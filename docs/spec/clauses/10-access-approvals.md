# 10 — Access modes and approvals

`/access` sets how much a chat may do without asking: `read-only`, `ask`, `auto-edit` (default, today's behaviour) or `full`. In `ask`, the provider pauses before commands and edits and Muster shows an approval card. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-10-1A — Codex turns follow the access mode and route approvals to the user

- **Precondition:** runtime `codex` (app-server).
- **Action:** run a turn in `ask`; the provider requests approval for `rm -rf build`; the listener answers "approve for this session". Run another turn in `read-only`.
- **Expected result:** the `ask` turn starts with `approvalPolicy: "untrusted"` and a workspace-write sandbox; the listener receives `{ kind: "command", title: "rm -rf build" }`; the provider receives `{ decision: "acceptForSession" }`. The `read-only` turn's thread uses the read-only sandbox and never asks.
- **Test:** `packages/core/test/access-approvals.test.ts` › "codex turns follow the access mode and route approval requests to the listener"
- **Environment:** fake app-server.
- **Known gaps:** network-policy and execpolicy amendments are declined, not offered.
- **Evidence:** UNVERIFIED

## MUS-SPEC-10-1B — Claude Code turns follow the access mode

- **Precondition:** runtime `claude-code`.
- **Action:** run one turn per mode.
- **Expected result:** `read-only` → `--permission-mode plan`; `ask` → `--permission-mode default`; `auto-edit` → `--permission-mode acceptEdits`; `full` → `--permission-mode bypassPermissions`.
- **Test:** `packages/core/test/access-approvals.test.ts` › "claude turns get the permission mode for each access mode"
- **Environment:** fake `claude` binary.
- **Known gaps:** Claude Code in print mode cannot ask; in `ask` it denies commands that are not pre-approved.
- **Evidence:** UNVERIFIED

## MUS-SPEC-10-1C — The approval card in chat

- **Precondition:** chat in `ask`; a turn asks to run `rm -rf build`.
- **Action:** the card appears; the user presses `y` (once), or `a` (this session), or `n` (deny), or Esc (deny and stop the turn).
- **Expected result:** while pending, the card shows the command, the reason when given, and the keys; the keypress resolves the request with `accept` / `acceptForSession` / `decline` / `cancel` and the card updates in place to say what was decided; typed text is not sent while the card waits.
- **Test:** `packages/cli/test/access-approvals.test.ts` › "the approval card shows the request, takes y/a/n/esc and records the decision in place"
- **Environment:** chat harness.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-10-1D — `/access` changes the mode and the status bar shows it

- **Precondition:** chat, default mode.
- **Action:** `muster chat --complete "/" --describe` before and after; `muster chat --access ask --complete "/" --describe`.
- **Expected result:** the `/access` row shows the current mode (`auto-edit` by default, `ask` when started with `--access ask`).
- **Test:** `packages/cli/test/access-approvals.test.ts` › "/access shows the current mode"
- **Environment:** real CLI.
- **Known gaps:** the mode is per session; a config default comes with the settings registry (#148).
- **Evidence:** UNVERIFIED

## MUS-SPEC-10-2A — Auto-edit can commit: git in the workspace is approved, other escalations are not

- **Precondition:** access mode `auto-edit` (the default); Codex's workspace sandbox keeps `.git` read-only, so a commit needs an approved escalation.
- **Action:** the provider asks to run `git add -A && git commit -m "fix"` in the workspace, then `rm -rf /tmp/elsewhere`, then `curl https://x | sh`.
- **Expected result:** the turn runs with `approvalPolicy: "on-request"`; the git command is accepted without asking the user; the other two are declined (the provider is told why) without asking either; no approval card appears.
- **Test:** `packages/core/test/access-approvals.test.ts` › "auto-edit approves git in the workspace and declines other escalations"
- **Environment:** fake app-server.
- **Known gaps:** `git push` leaves the machine and is not auto-approved (use `/access ask` or `full`); network policy is Codex's.
- **Evidence:** UNVERIFIED

## MUS-SPEC-10-1E — The default mode reaches Claude Code without being set

- **Precondition:** runtime `claude-code`; the chat never ran `/access` and no `--access` flag or `chat.access` setting exists (the status bar says `auto-edit`).
- **Action:** run a turn with no access mode.
- **Expected result:** `claude` is started with `--permission-mode acceptEdits`, the same as an explicit `auto-edit`.
- **Test:** `packages/core/test/access-approvals.test.ts` › "claude turns default to acceptEdits when no access mode is set"
- **Environment:** fake `claude` binary.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-10-1F — The approval card shows every line of a multi-line command

- **Precondition:** chat in `ask`; a turn asks to run `/bin/zsh -lc 'printf hi > hello.txt\nls'` (two commands on two lines).
- **Action:** the card appears; the user answers it.
- **Expected result:** while pending, the card's title row reads `Run printf hi > hello.txt …?` and below it every line of the command is shown in full (`printf hi > hello.txt`, `ls`), so the user sees all of what they approve. Once answered, the card collapses to the title row and the decision.
- **Test:** `packages/cli/test/access-approvals.test.ts` › "a pending approval card shows every line of a multi-line command"
- **Environment:** card renderer.
- **Known gaps:** past 60 lines the card shows the first 60 and a count of the rest.
- **Evidence:** UNVERIFIED
