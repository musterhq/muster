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
