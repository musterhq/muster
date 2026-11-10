# 21 — Voice: speech providers, voice notes on channels, spoken replies

Muster turns speech into text and text into speech through one provider layer (`packages/core/src/voice.ts`). The layer is off until configured, and local tools are preferred: whisper.cpp for speech-to-text, `say` (macOS) or a command for text-to-speech, and ffmpeg for format conversion. Cloud providers (an OpenAI-compatible `/audio/transcriptions` and `/audio/speech`, ElevenLabs) run only when configured explicitly, with keys as env references. Channels hand inbound audio to the layer before the turn, so a voice note becomes a normal prompt. Spoken replies are opt-in. Every transcription and synthesis leaves a receipt. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

Config (in `.muster/config.json`, under `voice`):
```json
{
  "voice": {
    "stt": { "provider": "whisper-cpp", "model": "~/models/ggml-small.en.bin" },
    "tts": { "provider": "say", "voice": "Samantha" },
    "reply": "off",
    "maxSeconds": 300
  }
}
```
`stt.provider`: `off` (default) | `whisper-cpp` | `command` | `openai`. `tts.provider`: `off` (default) | `say` | `command` | `openai` | `elevenlabs`. `reply`: `off` | `mirror` (answer a voice note with audio) | `always`.

Further optional fields (all have defaults):
- `stt`: `binary` (default `whisper-cli` on PATH), `language` (whisper `-l`, openai `language`), `timeoutMs`; `command` for the command provider (argv, `{input}`); `baseUrl`, `apiKeyEnv` for openai.
- `tts`: `binary` (default `say`), `outputExt` (the extension the command provider writes, default `wav`), `timeoutMs`; `command` (argv, `{text}`, `{output}`); `baseUrl`, `apiKeyEnv` for openai and elevenlabs.
- `maxBytes` (default 25 MB, the largest inbound audio file), `maxReplyChars` (default 1200), `ffmpeg` (default `ffmpeg` on PATH).

Receipts go to the voice ledger, `<data>/voice-ledger.jsonl`, next to the token ledger (`tokens.jsonl`) rather than inside it, so token reports keep one record shape.

On the envelope, `SurfaceAttachment` gains optional `seconds` and `sizeBytes` (checked before download), `SurfaceMessage` gains `voice = { seconds?, transcript }`, and `ChannelAdapter` gains optional `downloadAttachment` (Telegram `getFile`, Matrix authenticated media) and `sendVoice` (Telegram `sendVoice`, Matrix `m.audio`). Telegram audio attachments carry the pseudo-url `telegram-file:<file_id>`, so the bot token never appears in an envelope. Unpaired senders get the pairing challenge; their audio is never downloaded or transcribed. A voice note with a caption runs as the caption followed by the transcript; with speech off, a captioned note runs on its caption alone.

## MUS-SPEC-21-1A — Speech is off until configured, and doctor says what is available

- **Precondition:** no `voice` config. A PATH containing fake `whisper-cli`, `ffmpeg` and `say`, and a model file at a known path.
- **Action:** `muster voice doctor` (also `--json`).
- **Expected result:** it reports STT and TTS as `off`. It lists each local tool it found with its path, and the whisper model it found. It prints the exact config line that would turn local STT and TTS on. It makes no network call.
- **Test:** `packages/cli/test/voice.test.ts` › "voice doctor reports speech off and lists the local tools it found"
- **Environment:** fake binaries on PATH.
- **Known gaps:** none.
- **Evidence:** green 2026-11-10 on `feat/voice`: `npx tsx --test --test-concurrency=1` — core `test/voice.test.ts` 5/5, CLI `test/voice.test.ts` 3/3, gateway `test/voice-notes.test.ts` 5/5. Live on macOS: `muster voice doctor` with no config listed `/opt/homebrew/bin/whisper-cli`, `ffmpeg`, `/usr/bin/say`, `/usr/bin/afplay` and the local `ggml-small.en.bin`, and printed the config line.

## MUS-SPEC-21-1B — Local speech-to-text with whisper.cpp

- **Precondition:** `voice.stt = { provider: "whisper-cpp", model }`; a fake `whisper-cli` that echoes a fixed transcript for its `-f` input; an `.ogg` input.
- **Action:** `transcribe(file)` from core, and `muster voice transcribe <file>`.
- **Expected result:**
  - ffmpeg converts the input to 16 kHz mono WAV in a temp dir, which is then deleted.
  - `whisper-cli` gets the model and the WAV as separate argv entries, with no shell.
  - The result is the trimmed transcript, with timestamps and `[BLANK_AUDIO]` removed.
  - The CLI prints the text.
- **Test:** `packages/core/test/voice.test.ts` › "whisper-cpp transcribes through ffmpeg with argv only and cleans up"
- **Environment:** fake binaries. A live run uses the real whisper-cli with a `say`-generated clip.
- **Known gaps:** none.
- **Evidence:** green 2026-11-10 on `feat/voice`: `npx tsx --test --test-concurrency=1` — core `test/voice.test.ts` 5/5, CLI `test/voice.test.ts` 3/3, gateway `test/voice-notes.test.ts` 5/5. Live: real whisper-cli with `ggml-small.en.bin` transcribed a `say` clip of "what is two plus two" as "What is 2 + 2?".

## MUS-SPEC-21-1C — A command provider for either direction, with no shell

- **Precondition:** `voice.stt = { provider: "command", command: ["my-stt", "{input}"] }` and `voice.tts = { provider: "command", command: ["my-tts", "{text}", "{output}"] }`.
- **Action:** transcribe a file, and synthesize the text `a; rm -rf ~`.
- **Expected result:** the placeholders are replaced inside argv entries only. The text containing `;` reaches the command as one argument. Nothing is passed through a shell. A non-zero exit becomes an error naming the command and its stderr tail.
- **Test:** `packages/core/test/voice.test.ts` › "command providers substitute placeholders into argv and never use a shell"
- **Environment:** fake commands.
- **Known gaps:** none.
- **Evidence:** green 2026-11-10 on `feat/voice`: `npx tsx --test --test-concurrency=1` — core `test/voice.test.ts` 5/5, CLI `test/voice.test.ts` 3/3, gateway `test/voice-notes.test.ts` 5/5.

## MUS-SPEC-21-1D — Cloud providers run only when configured, and keys never leak

- **Precondition:**
  - `voice.stt = { provider: "openai", baseUrl, apiKeyEnv: "VOICE_KEY", model: "whisper-1" }`;
  - `voice.tts = { provider: "openai", ... }`;
  - a fake HTTP server;
  - `VOICE_KEY=sk-test-123`.
- **Action:** transcribe and synthesize. Then make the server return 401.
- **Expected result:**
  - Transcription sends a multipart POST to `{baseUrl}/audio/transcriptions` with `Authorization: Bearer sk-test-123`.
  - Speech sends a POST to `{baseUrl}/audio/speech` and writes the returned bytes to the output file.
  - On 401 the error names the provider and status, and never contains the key.
  - With `apiKeyEnv` unset, the error says which env var is missing, and no request is made.
- **Test:** `packages/core/test/voice.test.ts` › "openai voice providers use the env key, write audio, and never print the key"
- **Environment:** local fake HTTP server.
- **Known gaps:** ElevenLabs TTS follows the same shape (`xi-api-key` header); it is covered by its own case once added.
- **Evidence:** green 2026-11-10 on `feat/voice`: `npx tsx --test --test-concurrency=1` — core `test/voice.test.ts` 5/5, CLI `test/voice.test.ts` 3/3, gateway `test/voice-notes.test.ts` 5/5.

## MUS-SPEC-21-1E — Local text-to-speech with say, converted for the channel

- **Precondition:** `voice.tts = { provider: "say", voice: "Samantha" }`; fake `say` and `ffmpeg`.
- **Action:** `synthesize("hello", { format: "ogg-opus" })`.
- **Expected result:** `say -v Samantha -o <tmp>.aiff -- hello` runs, then ffmpeg converts the AIFF to Opus in an Ogg container. The result is a file path with mime `audio/ogg`, and temporary files are removed.
- **Test:** `packages/core/test/voice.test.ts` › "say synthesizes and ffmpeg converts to ogg opus"
- **Environment:** fake binaries. A live run uses the real `say` and `ffmpeg`.
- **Known gaps:** `say` exists only on macOS. Elsewhere doctor suggests `command` (piper) or a cloud provider.
- **Evidence:** green 2026-11-10 on `feat/voice`: `npx tsx --test --test-concurrency=1` — core `test/voice.test.ts` 5/5, CLI `test/voice.test.ts` 3/3, gateway `test/voice-notes.test.ts` 5/5. Live: real `say` + ffmpeg wrote Opus/48 kHz/mono in an Ogg container (ffprobe).

## MUS-SPEC-21-2A — A Telegram voice note becomes the turn's prompt

- **Precondition:**
  - the gateway with Telegram configured and STT configured (fake whisper);
  - a fake Bot API that serves `getFile` and the file bytes for a `message.voice`;
  - a paired sender.
- **Action:** POST an update carrying `message.voice` (file_id, duration 4, mime `audio/ogg`) and a caption-less message.
- **Expected result:**
  - The adapter downloads the file through `getFile`, and core transcribes it.
  - The turn runs with the prompt `<transcript>`, with a `voice` marker on the envelope (`message.voice = { seconds: 4, transcript }`).
  - The reply starts with a one-line `🎙 "<transcript, ≤80 chars>"` echo, so the user sees what was heard.
  - Durable ingress keys stay `telegram:<update_id>`.
- **Test:** `packages/gateway/test/voice-notes.test.ts` › "a telegram voice note is downloaded, transcribed and answered as a prompt"
- **Environment:** real gateway HTTP server, a fake Bot API, fake whisper.
- **Known gaps:** WhatsApp, Matrix and Discord follow the same path (21-2E). With `telegram.stream: "draft"` the reply is streamed, so the echo is sent as its own message just before it.
- **Evidence:** green 2026-11-10 on `feat/voice`: `npx tsx --test --test-concurrency=1` — core `test/voice.test.ts` 5/5, CLI `test/voice.test.ts` 3/3, gateway `test/voice-notes.test.ts` 5/5.

## MUS-SPEC-21-2B — Long or oversized audio is refused before any provider runs

- **Precondition:** `voice.maxSeconds = 300`; the Telegram fake serves a voice note with `duration: 900`, then a 30 MB audio document.
- **Action:** deliver both.
- **Expected result:** both get a reply naming the limit ("Voice notes up to 5 min; this one is 15 min."). Neither download nor transcription runs, and no turn starts.
- **Test:** `packages/gateway/test/voice-notes.test.ts` › "voice notes over the length or size limit are refused before download"
- **Environment:** as 21-2A.
- **Known gaps:** none.
- **Evidence:** green 2026-11-10 on `feat/voice`: `npx tsx --test --test-concurrency=1` — core `test/voice.test.ts` 5/5, CLI `test/voice.test.ts` 3/3, gateway `test/voice-notes.test.ts` 5/5.

## MUS-SPEC-21-2C — Voice without speech-to-text says how to turn it on

- **Precondition:** Telegram configured; `voice.stt` is off.
- **Action:** deliver a voice note.
- **Expected result:** the user gets one reply saying that voice notes need speech-to-text, plus the setup command (`muster voice doctor`). No turn runs on an empty prompt. The message is not silently dropped.
- **Test:** `packages/gateway/test/voice-notes.test.ts` › "a voice note with speech off gets a setup hint, not an empty turn"
- **Environment:** as 21-2A.
- **Known gaps:** none.
- **Evidence:** green 2026-11-10 on `feat/voice`: `npx tsx --test --test-concurrency=1` — core `test/voice.test.ts` 5/5, CLI `test/voice.test.ts` 3/3, gateway `test/voice-notes.test.ts` 5/5.

## MUS-SPEC-21-2D — Spoken replies are opt-in: mirror answers voice with voice

- **Precondition:** `voice.reply = "mirror"`; TTS configured (fake say and ffmpeg); a Telegram fake that records `sendVoice`.
- **Action:** deliver a voice note, then a text message.
- **Expected result:**
  - The voice note's reply is sent as text and also as `sendVoice` (`audio/ogg` Opus) carrying the reply's speakable text. Code blocks, URLs and tables are skipped, and the text is capped at `voice.maxReplyChars` (default 1200).
  - The text message gets text only.
  - With `reply: "off"`, neither gets audio.
- **Test:** `packages/gateway/test/voice-notes.test.ts` › "mirror replies to a voice note with text and a voice message, text gets text only"
- **Environment:** as 21-2A.
- **Known gaps:** none.
- **Evidence:** green 2026-11-10 on `feat/voice`: `npx tsx --test --test-concurrency=1` — core `test/voice.test.ts` 5/5, CLI `test/voice.test.ts` 3/3, gateway `test/voice-notes.test.ts` 5/5.

## MUS-SPEC-21-2E — The same voice path on every SDK channel that carries audio

- **Precondition:** the Matrix fake serves an `m.audio` event with an `mxc://` URL; the email fake serves an `audio/*` attachment.
- **Action:** deliver each.
- **Expected result:** each adapter exposes the audio as a `SurfaceAttachment`, and the shared runner path (not the adapter) transcribes it into the prompt, as in 21-2A. Channels that cannot carry audio are unaffected.
- **Test:** `packages/gateway/test/voice-notes.test.ts` › "matrix audio events and email audio attachments become prompts through the shared runner"
- **Environment:** fakes for Matrix and IMAP.
- **Known gaps:** WhatsApp and Discord join when they move onto the SDK (#171).
- **Evidence:** green 2026-11-10 on `feat/voice`: `npx tsx --test --test-concurrency=1` — core `test/voice.test.ts` 5/5, CLI `test/voice.test.ts` 3/3, gateway `test/voice-notes.test.ts` 5/5.

## MUS-SPEC-21-3A — Every transcription and synthesis leaves a receipt

- **Precondition:** any configured provider.
- **Action:** transcribe one clip and synthesize one reply.
- **Expected result:** each writes a ledger receipt with:
  - kind `voice.stt` or `voice.tts`;
  - provider, audio seconds or characters, and duration;
  - `local: true|false`;
  - an estimated cost (0 for local).

  The receipt never contains the audio, the key, or the transcript beyond 200 characters.
- **Test:** `packages/core/test/voice.test.ts` › "voice operations write receipts without audio, keys or full transcripts"
- **Environment:** fake providers.
- **Known gaps:** none.
- **Evidence:** green 2026-11-10 on `feat/voice`: `npx tsx --test --test-concurrency=1` — core `test/voice.test.ts` 5/5, CLI `test/voice.test.ts` 3/3, gateway `test/voice-notes.test.ts` 5/5. Live: the two live runs wrote `voice.stt` (whisper-cpp, 1.4 s, cost 0) and `voice.tts` (say, 17 chars, cost 0) receipts.

## MUS-SPEC-21-4A — `muster voice say` speaks or writes a file

- **Precondition:** TTS configured.
- **Action:** `muster voice say "hello there" -o /tmp/x.ogg`, then `muster voice say "hi"` with no `-o` on macOS.
- **Expected result:** the first command writes an Ogg/Opus file and prints its path. The second plays it (afplay; ffplay where afplay is missing) and exits 0. afplay cannot play Ogg/Opus, so playback speaks to a temporary WAV that is removed afterwards. A failure exits non-zero with the provider's error.
- **Test:** `packages/cli/test/voice.test.ts` › "voice say writes ogg with -o and plays without it"
- **Environment:** fake binaries.
- **Known gaps:** push-to-talk dictation in the chat composer is the next slice (spec 02, a new case).
- **Evidence:** green 2026-11-10 on `feat/voice`: `npx tsx --test --test-concurrency=1` — core `test/voice.test.ts` 5/5, CLI `test/voice.test.ts` 3/3, gateway `test/voice-notes.test.ts` 5/5. Live: `muster voice say "hello from muster" -o out.ogg` printed the path; ffprobe: `codec_name=opus`, `format_name=ogg`.
