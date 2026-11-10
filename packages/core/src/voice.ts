import { accessSync, constants } from "node:fs";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { runSubprocess } from "./subprocess.js";
import type { SubprocessError } from "./subprocess.js";

/**
 * Voice: speech-to-text and text-to-speech behind one provider layer
 * (docs/spec/clauses/21-voice.md). Off until configured. Local tools first
 * (whisper.cpp, macOS `say`, a user command, ffmpeg for conversion); cloud
 * providers run only when configured, with keys read from env references.
 *
 * Every external tool is spawned with an argv array and no shell. Temporary
 * audio lives in a mkdtemp dir that is always removed.
 */

export type SttProviderId = "off" | "whisper-cpp" | "command" | "openai";
export type TtsProviderId = "off" | "say" | "command" | "openai" | "elevenlabs";
export type VoiceReplyMode = "off" | "mirror" | "always";

export interface VoiceSttConfig {
  readonly provider: SttProviderId;
  /** whisper-cpp: path to a ggml model (`~` expands). openai: model id (default whisper-1). */
  readonly model?: string;
  /** whisper-cpp: the binary (default `whisper-cli` on PATH). */
  readonly binary?: string;
  /** Spoken language hint (whisper `-l`, openai `language`). */
  readonly language?: string;
  /** command: argv with `{input}` (the audio file). The transcript is the command's stdout. */
  readonly command?: readonly string[];
  /** openai: API base such as https://api.openai.com/v1. */
  readonly baseUrl?: string;
  /** openai: NAME of the environment variable holding the key. Never the key. */
  readonly apiKeyEnv?: string;
  readonly timeoutMs?: number;
}

export interface VoiceTtsConfig {
  readonly provider: TtsProviderId;
  /** say: `-v` voice. openai: voice (default alloy). elevenlabs: voice id. */
  readonly voice?: string;
  /** openai: model (default tts-1). elevenlabs: model_id. */
  readonly model?: string;
  /** say: the binary (default `say` on PATH). */
  readonly binary?: string;
  /** command: argv with `{text}` and `{output}`. */
  readonly command?: readonly string[];
  /** command: the extension of the file the command writes (default wav). */
  readonly outputExt?: string;
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly timeoutMs?: number;
}

export interface VoiceConfig {
  readonly stt?: VoiceSttConfig;
  readonly tts?: VoiceTtsConfig;
  /** Spoken replies on channels: off (default), mirror (answer voice with voice), always. */
  readonly reply?: VoiceReplyMode;
  /** Longest inbound voice note, in seconds (default 300). */
  readonly maxSeconds?: number;
  /** Largest inbound audio file, in bytes (default 25 MB). */
  readonly maxBytes?: number;
  /** Longest spoken reply, in characters (default 1200). */
  readonly maxReplyChars?: number;
  /** ffmpeg binary (default `ffmpeg` on PATH). */
  readonly ffmpeg?: string;
}

export const VOICE_DEFAULTS = {
  maxSeconds: 300,
  maxBytes: 25 * 1024 * 1024,
  maxReplyChars: 1200,
} as const;

export type VoiceEnv = Readonly<Record<string, string | undefined>>;

export interface VoiceRunOptions {
  readonly voice: VoiceConfig | undefined;
  readonly cwd?: string;
  /** Where binaries are found (PATH) and `apiKeyEnv` is resolved. Defaults to process.env. */
  readonly env?: VoiceEnv;
  readonly fetcher?: typeof fetch;
  /** Recorded on the receipt (e.g. "telegram:bot"). */
  readonly surfaceId?: string;
}

export interface TranscribeOptions extends VoiceRunOptions {
  /** Refuse audio longer than this after conversion (default voice.maxSeconds). */
  readonly maxSeconds?: number;
}

export interface TranscribeResult {
  readonly text: string;
  readonly provider: SttProviderId;
  readonly local: boolean;
  /** Audio length when it could be measured. */
  readonly seconds?: number;
  readonly durationMs: number;
}

export type SynthesisFormat = "ogg-opus" | "wav";

export interface SynthesizeOptions extends VoiceRunOptions {
  readonly format?: SynthesisFormat;
  /** Write here instead of a temp file. */
  readonly output?: string;
}

export interface SynthesizeResult {
  readonly path: string;
  readonly mime: string;
  readonly provider: TtsProviderId;
  readonly local: boolean;
  readonly characters: number;
  readonly durationMs: number;
  /** Removes the file when it was written to a temp dir; no-op for `output`. */
  cleanup(): Promise<void>;
}

/** Raised when audio is over the configured length or size. */
export class VoiceLimitError extends Error {
  constructor(message: string, readonly limit: "seconds" | "bytes") {
    super(message);
    this.name = "VoiceLimitError";
  }
}

// ---- Tools ----------------------------------------------------------------------------

function expandHome(path: string, env: VoiceEnv): string {
  return path === "~" || path.startsWith("~/") ? join(env.HOME ?? process.env.HOME ?? "", path.slice(1)) : path;
}

/** Find an executable by name on env.PATH (or check an absolute path). */
export function findExecutable(name: string, env: VoiceEnv = process.env): string | undefined {
  const candidates = isAbsolute(name) || name.includes("/")
    ? [expandHome(name, env)]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function requireExecutable(name: string, env: VoiceEnv, hint: string): string {
  const found = findExecutable(name, env);
  if (!found) throw new Error(`${name} was not found on PATH. ${hint}`);
  return found;
}

function tail(text: string | undefined, lines = 3): string {
  return (text ?? "").trim().split("\n").slice(-lines).join(" | ").slice(0, 400);
}

async function run(binary: string, args: readonly string[], env: VoiceEnv, timeoutMs: number, label = binary): Promise<string> {
  try {
    const { stdout } = await runSubprocess(binary, args, { env: env as NodeJS.ProcessEnv, timeoutMs });
    return stdout;
  } catch (error) {
    const failure = error as SubprocessError;
    if (failure.code === "ENOENT") throw new Error(`${label} was not found.`);
    const exit = typeof failure.code === "number" ? `exit ${failure.code}` : failure.killed ? `timed out after ${timeoutMs}ms` : failure.message;
    const stderr = tail(failure.stderr);
    throw new Error(`${label} failed (${exit})${stderr ? `: ${stderr}` : ""}`);
  }
}

async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "muster-voice-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ffmpegBinary(voice: VoiceConfig | undefined, env: VoiceEnv): string {
  return requireExecutable(voice?.ffmpeg ?? "ffmpeg", env, "Install ffmpeg (brew install ffmpeg) to convert audio.");
}

const FFMPEG_QUIET = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"] as const;

async function toWav16k(voice: VoiceConfig | undefined, input: string, output: string, env: VoiceEnv): Promise<void> {
  await run(ffmpegBinary(voice, env), [...FFMPEG_QUIET, "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", output], env, 120_000, "ffmpeg");
}

async function convertFor(voice: VoiceConfig | undefined, input: string, output: string, format: SynthesisFormat, env: VoiceEnv): Promise<void> {
  const codec = format === "ogg-opus"
    ? ["-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", "-f", "ogg"]
    : ["-c:a", "pcm_s16le", "-ar", "22050", "-ac", "1", "-f", "wav"];
  await run(ffmpegBinary(voice, env), [...FFMPEG_QUIET, "-i", input, ...codec, output], env, 120_000, "ffmpeg");
}

/** Seconds of 16 kHz mono 16-bit PCM in a WAV written by toWav16k. */
async function wavSeconds(path: string): Promise<number> {
  const size = (await stat(path)).size;
  return Math.max(0, Math.round(((size - 44) / 32_000) * 10) / 10);
}

/** whisper.cpp output → plain transcript: no timestamps, no [BLANK_AUDIO]-style markers. */
export function cleanTranscript(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line
      .replace(/^\s*\[\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\s*-->\s*\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\]\s*/, "")
      .replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE)\]|\((?:silence|music|noise)\)/gi, "")
      .trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Replace `{name}` placeholders inside argv entries. The values are never re-scanned. */
export function substituteArgv(template: readonly string[], values: Readonly<Record<string, string>>): string[] {
  return template.map((entry) => entry.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? values[key] : match)));
}

function mimeFor(format: SynthesisFormat): string {
  return format === "ogg-opus" ? "audio/ogg" : "audio/wav";
}

function extFor(format: SynthesisFormat): string {
  return format === "ogg-opus" ? "ogg" : "wav";
}

// ---- Speech to text ---------------------------------------------------------------------

export function sttEnabled(voice: VoiceConfig | undefined): boolean {
  return Boolean(voice?.stt?.provider && voice.stt.provider !== "off");
}

export function ttsEnabled(voice: VoiceConfig | undefined): boolean {
  return Boolean(voice?.tts?.provider && voice.tts.provider !== "off");
}

/** Transcribe an audio file with the configured speech-to-text provider. */
export async function transcribe(file: string, options: TranscribeOptions): Promise<TranscribeResult> {
  const stt = options.voice?.stt;
  if (!stt || stt.provider === "off") throw new Error("Speech-to-text is off. Run `muster voice doctor` to turn it on.");
  const env = options.env ?? process.env;
  const started = Date.now();
  const maxSeconds = options.maxSeconds ?? options.voice?.maxSeconds ?? VOICE_DEFAULTS.maxSeconds;
  const timeoutMs = stt.timeoutMs ?? 300_000;
  let text: string;
  let seconds: number | undefined;
  if (stt.provider === "whisper-cpp") {
    if (!stt.model) throw new Error("voice.stt.model is required for whisper-cpp (a ggml model file). Run `muster voice doctor`.");
    const model = expandHome(stt.model, env);
    const binary = requireExecutable(stt.binary ?? "whisper-cli", env, "Install whisper.cpp (brew install whisper-cpp) or set voice.stt.binary.");
    const raw = await withTempDir(async (dir) => {
      const wav = join(dir, "input.wav");
      await toWav16k(options.voice, file, wav, env);
      seconds = await wavSeconds(wav);
      if (seconds > maxSeconds) throw new VoiceLimitError(limitMessage(seconds, maxSeconds), "seconds");
      const args = ["-m", model, "-f", wav, "-nt", "-np"];
      if (stt.language) args.push("-l", stt.language);
      return run(binary, args, env, timeoutMs, "whisper-cli");
    });
    text = cleanTranscript(raw);
  } else if (stt.provider === "command") {
    if (!stt.command?.length) throw new Error("voice.stt.command is required for the command provider, e.g. [\"my-stt\", \"{input}\"].");
    const [program, ...args] = substituteArgv(stt.command, { input: file });
    text = cleanTranscript(await run(program, args, env, timeoutMs, program));
  } else {
    throw new Error(`Unknown speech-to-text provider: ${String(stt.provider)}`);
  }
  return { text, provider: stt.provider, local: true, seconds, durationMs: Date.now() - started };
}

// ---- Text to speech ---------------------------------------------------------------------

/** Speak `text` into an audio file with the configured text-to-speech provider. */
export async function synthesize(text: string, options: SynthesizeOptions): Promise<SynthesizeResult> {
  const tts = options.voice?.tts;
  if (!tts || tts.provider === "off") throw new Error("Text-to-speech is off. Run `muster voice doctor` to turn it on.");
  if (!text.trim()) throw new Error("Nothing to speak.");
  const env = options.env ?? process.env;
  const format = options.format ?? "ogg-opus";
  const started = Date.now();
  const timeoutMs = tts.timeoutMs ?? 120_000;
  const outDir = options.output ? undefined : await mkdtemp(join(tmpdir(), "muster-voice-out-"));
  const path = options.output ?? join(outDir!, `speech.${extFor(format)}`);
  try {
    await withTempDir(async (dir) => {
      if (tts.provider === "say") {
        const binary = requireExecutable(tts.binary ?? "say", env, "`say` exists only on macOS; use the command provider (e.g. piper) or a cloud provider.");
        const aiff = join(dir, "speech.aiff");
        await run(binary, [...(tts.voice ? ["-v", tts.voice] : []), "-o", aiff, "--", text], env, timeoutMs, "say");
        await convertFor(options.voice, aiff, path, format, env);
      } else if (tts.provider === "command") {
        if (!tts.command?.length) throw new Error("voice.tts.command is required for the command provider, e.g. [\"my-tts\", \"{text}\", \"{output}\"].");
        const ext = (tts.outputExt ?? "wav").replace(/^\./, "");
        const produced = join(dir, `speech.${ext}`);
        const [program, ...args] = substituteArgv(tts.command, { text, output: produced });
        await run(program, args, env, timeoutMs, program);
        if (ext === extFor(format) || (format === "ogg-opus" && ext === "opus")) await copyFile(produced, path);
        else await convertFor(options.voice, produced, path, format, env);
      } else {
        throw new Error(`Unknown text-to-speech provider: ${String(tts.provider)}`);
      }
    });
  } catch (error) {
    if (outDir) await rm(outDir, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    mime: mimeFor(format),
    provider: tts.provider,
    local: true,
    characters: text.length,
    durationMs: Date.now() - started,
    cleanup: async () => {
      if (outDir) await rm(outDir, { recursive: true, force: true });
    },
  };
}

// ---- Limits -----------------------------------------------------------------------------

/** "5 min", "45 s", "1.5 min". */
export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round((seconds / 60) * 10) / 10;
  return `${minutes} min`;
}

export function formatBytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

export function limitMessage(seconds: number, maxSeconds: number): string {
  return `Voice notes up to ${formatSeconds(maxSeconds)}; this one is ${formatSeconds(seconds)}.`;
}

export function sizeLimitMessage(bytes: number, maxBytes: number): string {
  return `Voice notes up to ${formatBytes(maxBytes)}; this one is ${formatBytes(bytes)}.`;
}
