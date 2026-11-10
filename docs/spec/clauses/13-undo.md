# 13 — Undo a turn's file changes

`/undo` puts back every file the last turn changed, using the observer's recorded diffs. A file that changed again after the turn is left alone. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-13-1A — Undo restores modified, created and deleted files

- **Precondition:** a git repo with `a.txt` and `gone.txt`; during a turn the observer records: `a.txt` edited twice, `new.txt` created, `gone.txt` deleted.
- **Action:** undo those events.
- **Expected result:** `a.txt` and `gone.txt` have their original content again, `new.txt` no longer exists, and the result lists the three files as restored.
- **Test:** `packages/core/test/workspace-undo.test.ts` › "undo restores modified, created and deleted files"
- **Environment:** real git repo, real workspace observer (flush-driven).
- **Known gaps:** binary files without a recorded diff are skipped with a reason.
- **Evidence:** UNVERIFIED

## MUS-SPEC-13-1B — A file edited after the turn is not touched

- **Precondition:** as 13-1A, then the user edits `a.txt` again after the turn.
- **Action:** undo.
- **Expected result:** `a.txt` keeps the user's newer content and is reported as skipped ("changed since the turn"); the other files are restored.
- **Test:** `packages/core/test/workspace-undo.test.ts` › "undo leaves files changed after the turn alone"
- **Environment:** as above.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-13-1C — Undo in a folder that is not a git repository says why it cannot work

- **Precondition:** chat in a folder that is not a git repository, so the workspace observer cannot start (`live diff off: not a git repository`); the last turn edited `data.csv`.
- **Action:** `/undo`.
- **Expected result:** the reply says plainly that undo needs a git repository (and how to get one: `git init`); it never says the last turn changed no files. With live diff turned off by the user, the reply says undo needs live diff on.
- **Test:** `packages/cli/test/live-diff-render.test.ts` › "undo in a folder that is not a git repository says it needs git, never that nothing changed"
- **Environment:** real non-git temp dir, real workspace observer.
- **Known gaps:** Muster does not undo untracked turns itself; the user needs git.
- **Evidence:** UNVERIFIED

## MUS-SPEC-13-1D — Undo and rewind share one record of a turn's changes

- **Precondition:** chat in a git repo; the last turn changed `calc.py` and created `notes2.txt`.
- **Action:** `/undo`; then open `/rewind`; then `/undo` again.
- **Expected result:** after the undo the turn's recorded changes are cleared for `/rewind` too: the picker shows the turn as `· undone` (not `· 2 file(s)`), and rewinding past it does not report those files as "left alone". A second `/undo` says the last turn's changes were already undone, never that it "changed no files".
- **Test:** `packages/cli/test/live-diff-render.test.ts` › "an undone turn has no changes left for rewind, and a second undo says it was already undone"
- **Environment:** pure helpers (`markTurnUndone`, `rewindTurnLabel`, `undoLastTurnRows`).
- **Known gaps:** none.
- **Evidence:** live, 2026-11-10 in a git scratch repo: `/undo` → `Undid 2 files`, `/undo` again → `Already undone: …`; the `/rewind` picker listed the turn as `· undone` and the rewind reported `0 files restored` with no "left alone" rows. Red→green: live-diff-render.test.ts.
