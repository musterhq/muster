# 17 — Rewind

`/rewind` goes back to just before an earlier turn: the files that turn and every later turn changed are put back, and the provider's conversation forgets those turns. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-17-1A — Codex runs report their turn id

- **Precondition:** runtime `codex` (app-server).
- **Action:** run a turn.
- **Expected result:** the outcome carries the provider thread id and turn id.
- **Test:** `packages/core/test/rewind.test.ts` › "codex runs report the provider turn id"
- **Environment:** fake app-server.
- **Known gaps:** Claude Code and pi report no turn id; rewinding them starts a fresh provider thread.
- **Evidence:** UNVERIFIED

## MUS-SPEC-17-1B — Rewinding to turn 2 of 3 restores files and reverts the conversation

- **Precondition:** three recorded turns; turn 1 edited `a.txt`, turn 2 edited `a.txt` again and created `b.txt`, turn 3 edited `c.txt`.
- **Action:** rewind to before turn 2.
- **Expected result:** `a.txt` has its after-turn-1 content, `b.txt` is gone, `c.txt` has its original content; the conversation is reverted with `beforeTurnId` = turn 2's id; the result names turn 2's prompt for the composer.
- **Test:** `packages/core/test/rewind.test.ts` › "rewinding to an earlier turn restores files from that turn on and reverts the thread"
- **Environment:** real git repo and workspace observer; fake revert call.
- **Known gaps:** files changed after the last turn are left alone (as `/undo`).
- **Evidence:** UNVERIFIED

## MUS-SPEC-17-1C — Rewound turns are forgotten by Muster's memory too

- **Precondition:** turn A and turn B each wrote an automatic `episode_summary` memory (provenance `run:<id>`); the user also has a fact they asked Muster to remember.
- **Action:** forget the turn memories of run B (what `/rewind` does for every rewound turn).
- **Expected result:** B's summary is gone from listing and from search; A's summary and the user's fact remain.
- **Test:** `packages/core/test/rewind.test.ts` › "rewind forgets the automatic memories of rewound turns and keeps everything else"
- **Environment:** temp memory store (JSONL + rebuilt index).
- **Known gaps:** Codex's own server-side history is reverted by `thread/revert`; Claude Code sessions start fresh instead.
- **Evidence:** UNVERIFIED

## MUS-SPEC-17-2A — Rewound turns are greyed out in the transcript

- **Precondition:** a chat with turns "first", "second", "third".
- **Action:** `/rewind 2` (rewinds "second" and "third").
- **Expected result:** a dim `↺ rewound — the turns below were undone` row is inserted above "> second", and every row from "> second" on is repainted grey, so the transcript no longer reads as if those turns still stand; "first" keeps its look.
- **Test:** `packages/cli/test/chat-composer.test.ts` › "rewound turns are greyed out in the transcript"
- **Environment:** chat harness.
- **Known gaps:** when the same prompt was sent more than once, the latest copy is the one marked.
- **Evidence:** live, 2026-11-10: after `/rewind` of 2 turns, PgUp shows `↺ rewound — the turns below were undone` above the rewound prompt and the rows below in grey (`38;2;148;144;140`). Red→green: chat-composer.test.ts.

## MUS-SPEC-17-3A — The rewind picker is titled, aligned and lists only turns worth rewinding

- **Precondition:** a chat with 13 turns; turn 4 failed before doing anything (`Command failed (exit 1)`, no file changes).
- **Action:** run `/rewind` with no number.
- **Expected result:** the picker opens under a rule with the title `Rewind to before which turn?` and a dim key hint `↑↓ choose · enter select · esc cancel`; turn numbers are right-aligned so the prompts of turns 1–9 and 10+ start in one column; a failed turn that changed no files is not recorded, so it is neither listed nor counted (a failed turn that did change files is still listed).
- **Test:** `packages/cli/test/chat-composer.test.ts` › "the rewind picker is titled, aligned and leaves out failed turns"
- **Environment:** pure `rewindPickerOptions` / `recordableTurn` (`live-diff.ts`) and `RuledOverlay`, NO_COLOR.
- **Known gaps:** the picker shows the 15 most recent turns.
- **Evidence:** UNVERIFIED

## MUS-SPEC-17-3B — The rewind result names the prompt without cutting a word

- **Precondition:** a turn whose prompt is "Create b.txt containing two. Remember the second codeword is WALRUS."
- **Action:** rewind to before it.
- **Expected result:** the result line quotes the prompt whole when it fits in 60 characters; a longer prompt is cut at the last word boundary and ends in `…` (never "…the second codeword is”" with no mark).
- **Test:** `packages/cli/test/chat-composer.test.ts` › "the rewind result quotes the prompt and cuts only at a word"
- **Environment:** pure `rewindPromptPreview` (`live-diff.ts`).
- **Known gaps:** none.
- **Evidence:** UNVERIFIED
