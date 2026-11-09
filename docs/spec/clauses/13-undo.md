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
