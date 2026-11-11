# 22 — Dictation: speak a prompt into the chat composer

The chat composer takes speech. A key starts recording from the default microphone (sox `rec`, or ffmpeg's avfoundation/pulse input). The same key, or Enter, stops it. The clip is transcribed with the configured `voice.stt` provider (spec 21), and the text is **inserted into the composer at the cursor for review. It is never sent on its own.** Recording shows a live row with elapsed time and a level meter; Esc cancels and discards the clip. Audio never leaves the machine unless `voice.stt` is a cloud provider. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

Key: `Ctrl+R` (record). `/dictate` does the same for terminals that take Ctrl+R. Config: `voice.dictation.maxSeconds` (default 120), `voice.dictation.input` (default: the system default device).

## MUS-SPEC-22-1A — Ctrl+R records, Ctrl+R stops, the text lands in the composer unsent

- **Precondition:** chat TUI with `voice.stt` set to whisper-cpp; fake `rec` that writes a WAV and exits on SIGINT; fake whisper that prints "add a test for the parser"; the composer holds "please ".
- **Action:** Ctrl+R, wait 300 ms, Ctrl+R.
- **Expected result:**
  - While recording, the row above the composer reads `● Recording 0:00 ▁▃▅ · ctrl+r stop · esc cancel`, and the timer advances.
  - On stop, the row reads `Transcribing…`, and then the composer holds `please add a test for the parser`.
  - The cursor is at the end. No turn starts, and nothing is sent until the user presses Enter.
  - `rec` was spawned with argv only and received SIGINT, and the temp WAV is removed.
- **Test:** `packages/cli/test/chat-dictation.test.ts` › "ctrl+r records and inserts the transcript into the composer without sending"
- **Environment:** harness sink, fake `rec` and whisper on PATH.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-22-1B — Esc cancels a recording and discards the audio

- **Precondition:** recording in progress (22-1A setup).
- **Action:** Esc.
- **Expected result:** the recorder is stopped, no transcription runs, the composer text is unchanged, the row disappears, and the temp audio is deleted. Esc does not also interrupt a running turn.
- **Test:** `packages/cli/test/chat-dictation.test.ts` › "esc cancels a recording without transcribing"
- **Environment:** as 22-1A.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-22-1C — Dictation without speech-to-text or a recorder says how to set it up

- **Precondition:** (a) `voice.stt` off; (b) STT on, but neither `rec` nor `ffmpeg` is on PATH.
- **Action:** Ctrl+R in each case.
- **Expected result:**
  - (a) One dim line: `Dictation needs speech-to-text: run muster voice doctor`.
  - (b) `Dictation needs a recorder: brew install sox`.
  - In both cases nothing is spawned and the composer is untouched.
- **Test:** `packages/cli/test/chat-dictation.test.ts` › "dictation without stt or a recorder explains the setup"
- **Environment:** harness sink, a PATH without the tools.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-22-1D — A recording stops itself at the limit

- **Precondition:** `voice.dictation.maxSeconds = 1`.
- **Action:** Ctrl+R, then wait 1.5 s.
- **Expected result:** the recorder is stopped at 1 s and the clip is transcribed as in 22-1A. A dim note `stopped at the 1 s limit` appears.
- **Test:** `packages/cli/test/chat-dictation.test.ts` › "a recording stops at the dictation limit and is still transcribed"
- **Environment:** as 22-1A.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-22-1E — Dictation works while a turn runs (steer by voice)

- **Precondition:** a turn is running.
- **Action:** Ctrl+R, speak, Ctrl+R, then Enter.
- **Expected result:** the transcript goes into the composer as in 22-1A, and Enter steers the running turn exactly as typed text would (spec 02 steer). Recording never interrupts the turn.
- **Test:** `packages/cli/test/chat-dictation.test.ts` › "dictated text can steer a running turn"
- **Environment:** harness sink with a fake running turn.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-22-2A — `/shortcuts`, `/help` and the receipt know about dictation

- **Precondition:** chat TUI.
- **Action:** `/shortcuts`; then dictate once.
- **Expected result:**
  - `/shortcuts` lists `Ctrl+R  dictate a prompt (speech-to-text)`.
  - The voice ledger gets one `voice.stt` receipt with `surfaceId: "chat"`.
- **Test:** `packages/cli/test/chat-dictation.test.ts` › "dictation is listed in shortcuts and leaves a voice receipt"
- **Environment:** as 22-1A.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED
