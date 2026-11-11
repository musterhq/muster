import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { profileDataDir } from "./profiles.js";
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
  /** Chat dictation (docs/spec/clauses/22-dictation.md). */
  readonly dictation?: VoiceDictationConfig;
}

export interface VoiceDictationConfig {
  /** A recording stops itself after this many seconds (default 120). */
  readonly maxSeconds?: number;
  /** Input device: sox AUDIODEV, ffmpeg avfoundation index/name or pulse source (default: the system default). */
  readonly input?: string;
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

// ---- Cloud ------------------------------------------------------------------------------

/** Resolve `apiKeyEnv`. The error names the variable, never a value; no request is made without it. */
function requireKey(env: VoiceEnv, name: string | undefined, what: string): string {
  if (!name) throw new Error(`${what} needs apiKeyEnv: the NAME of the environment variable holding the key.`);
  const value = env[name];
  if (typeof value !== "string" || !value) throw new Error(`${what} is not available: set the environment variable ${name}.`);
  return value;
}

function redact(text: string, key: string): string {
  return key ? text.split(key).join("[redacted]") : text;
}

async function cloudFailure(provider: string, operation: string, response: Response, key: string): Promise<Error> {
  // The status names the failure; a short body tail helps, with the key removed.
  const body = await response.text().catch(() => "");
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; detail?: unknown };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.detail;
    if (typeof message === "string") detail = message;
  } catch {
    detail = "";
  }
  detail = redact(detail, key).replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\b(sk|xi)-[A-Za-z0-9_-]{4,}/g, "[redacted]").slice(0, 200);
  return new Error(`${provider} ${operation} failed: HTTP ${response.status}${detail ? ` (${detail})` : ""}`);
}

async function cloudFetch(fetcher: typeof fetch, url: string, init: RequestInit, provider: string, operation: string, key: string, timeoutMs: number): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${provider} ${operation} failed: ${redact(message, key)}`);
  }
  if (!response.ok) throw await cloudFailure(provider, operation, response, key);
  return response;
}

function trimBase(url: string | undefined, fallback: string): string {
  return (url ?? fallback).replace(/\/+$/, "");
}

const AUDIO_MIME: Record<string, string> = { ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", webm: "audio/webm", flac: "audio/flac", aiff: "audio/aiff" };

function audioMimeOf(file: string): string {
  return AUDIO_MIME[file.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

// ---- Speech to text ---------------------------------------------------------------------

export function sttEnabled(voice: VoiceConfig | undefined): boolean {
  return Boolean(voice?.stt?.provider && voice.stt.provider !== "off");
}

export function ttsEnabled(voice: VoiceConfig | undefined): boolean {
  return Boolean(voice?.tts?.provider && voice.tts.provider !== "off");
}

/** Transcribe an audio file with the configured speech-to-text provider. Leaves a receipt. */
export async function transcribe(file: string, options: TranscribeOptions): Promise<TranscribeResult> {
  const started = Date.now();
  const provider = options.voice?.stt?.provider ?? "off";
  try {
    const result = await transcribeWith(file, options);
    const seconds = result.seconds ?? (result.local ? undefined : await estimatedSeconds(file));
    await recordVoiceReceipt({
      kind: "voice.stt",
      provider,
      model: options.voice?.stt?.model && !result.local ? options.voice.stt.model : undefined,
      local: result.local,
      ok: true,
      audioSeconds: seconds,
      durationMs: result.durationMs,
      costUsd: estimateVoiceCostUsd("voice.stt", provider, { seconds }),
      transcriptPreview: result.text.slice(0, 200),
      surfaceId: options.surfaceId,
    }, options.cwd);
    return result;
  } catch (error) {
    if (provider !== "off") {
      await recordVoiceReceipt({
        kind: "voice.stt", provider, local: isLocalProvider(provider), ok: false,
        durationMs: Date.now() - started, costUsd: 0, error: errorSummary(error), surfaceId: options.surfaceId,
      }, options.cwd);
    }
    throw error;
  }
}

async function transcribeWith(file: string, options: TranscribeOptions): Promise<TranscribeResult> {
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
  } else if (stt.provider === "openai") {
    const key = requireKey(env, stt.apiKeyEnv, "openai speech-to-text");
    const bytes = await readFile(file);
    if (bytes.length > (options.voice?.maxBytes ?? VOICE_DEFAULTS.maxBytes)) {
      throw new VoiceLimitError(sizeLimitMessage(bytes.length, options.voice?.maxBytes ?? VOICE_DEFAULTS.maxBytes), "bytes");
    }
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: audioMimeOf(file) }), basename(file));
    form.set("model", stt.model ?? "whisper-1");
    form.set("response_format", "json");
    if (stt.language) form.set("language", stt.language);
    const response = await cloudFetch(options.fetcher ?? fetch, `${trimBase(stt.baseUrl, "https://api.openai.com/v1")}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
    }, "openai", "speech-to-text", key, timeoutMs);
    const payload = await response.json().catch(() => ({})) as { text?: unknown; duration?: unknown };
    text = cleanTranscript(typeof payload.text === "string" ? payload.text : "");
    if (typeof payload.duration === "number") seconds = payload.duration;
    return { text, provider: stt.provider, local: false, seconds, durationMs: Date.now() - started };
  } else {
    throw new Error(`Unknown speech-to-text provider: ${String(stt.provider)}`);
  }
  return { text, provider: stt.provider, local: true, seconds, durationMs: Date.now() - started };
}

// ---- Text to speech ---------------------------------------------------------------------

/** Speak `text` into an audio file with the configured text-to-speech provider. Leaves a receipt. */
export async function synthesize(text: string, options: SynthesizeOptions): Promise<SynthesizeResult> {
  const started = Date.now();
  const provider = options.voice?.tts?.provider ?? "off";
  try {
    const result = await synthesizeWith(text, options);
    await recordVoiceReceipt({
      kind: "voice.tts",
      provider,
      local: result.local,
      ok: true,
      characters: result.characters,
      durationMs: result.durationMs,
      costUsd: estimateVoiceCostUsd("voice.tts", provider, { characters: result.characters }),
      surfaceId: options.surfaceId,
    }, options.cwd);
    return result;
  } catch (error) {
    if (provider !== "off") {
      await recordVoiceReceipt({
        kind: "voice.tts", provider, local: isLocalProvider(provider), ok: false, characters: text.length,
        durationMs: Date.now() - started, costUsd: 0, error: errorSummary(error), surfaceId: options.surfaceId,
      }, options.cwd);
    }
    throw error;
  }
}

async function synthesizeWith(text: string, options: SynthesizeOptions): Promise<SynthesizeResult> {
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
      } else if (tts.provider === "openai") {
        const key = requireKey(env, tts.apiKeyEnv, "openai text-to-speech");
        const response = await cloudFetch(options.fetcher ?? fetch, `${trimBase(tts.baseUrl, "https://api.openai.com/v1")}/audio/speech`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: tts.model ?? "tts-1", voice: tts.voice ?? "alloy", input: text, response_format: format === "ogg-opus" ? "opus" : "wav" }),
        }, "openai", "text-to-speech", key, timeoutMs);
        // OpenAI's "opus" is Ogg/Opus and "wav" is WAV: written as returned.
        await writeFile(path, Buffer.from(await response.arrayBuffer()));
      } else if (tts.provider === "elevenlabs") {
        const key = requireKey(env, tts.apiKeyEnv, "elevenlabs text-to-speech");
        if (!tts.voice) throw new Error("voice.tts.voice (an ElevenLabs voice id) is required for elevenlabs.");
        const response = await cloudFetch(options.fetcher ?? fetch, `${trimBase(tts.baseUrl, "https://api.elevenlabs.io/v1")}/text-to-speech/${encodeURIComponent(tts.voice)}?output_format=mp3_44100_128`, {
          method: "POST",
          headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
          body: JSON.stringify({ text, ...(tts.model ? { model_id: tts.model } : {}) }),
        }, "elevenlabs", "text-to-speech", key, timeoutMs);
        const mp3 = join(dir, "speech.mp3");
        await writeFile(mp3, Buffer.from(await response.arrayBuffer()));
        await convertFor(options.voice, mp3, path, format, env);
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
    local: tts.provider === "say" || tts.provider === "command",
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

// ---- Receipts ---------------------------------------------------------------------------

/**
 * One line in the voice ledger (`<data>/voice-ledger.jsonl`). Never holds the
 * audio, a key, the spoken text, or more than 200 characters of transcript.
 */
export interface VoiceReceipt {
  readonly id: string;
  readonly kind: "voice.stt" | "voice.tts";
  readonly createdAt: string;
  readonly provider: string;
  readonly model?: string;
  readonly local: boolean;
  readonly ok: boolean;
  readonly audioSeconds?: number;
  readonly characters?: number;
  readonly durationMs: number;
  /** Estimate from public list prices; 0 for local providers. */
  readonly costUsd: number;
  readonly transcriptPreview?: string;
  readonly error?: string;
  readonly surfaceId?: string;
}

export function voiceLedgerPath(cwd = process.cwd()): string {
  return join(profileDataDir(cwd), "voice-ledger.jsonl");
}

function isLocalProvider(provider: string): boolean {
  return provider === "whisper-cpp" || provider === "command" || provider === "say";
}

function errorSummary(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

async function estimatedSeconds(file: string): Promise<number> {
  // Voice notes are ~16 kbit/s Opus; only used to estimate a cloud cost when the provider reports no duration.
  const size = await stat(file).then((info) => info.size).catch(() => 0);
  return Math.max(1, Math.round(size / 2_000));
}

/** Rough list prices: OpenAI transcription $0.006/min, OpenAI speech $15/1M chars, ElevenLabs ~$0.30/1K chars. */
export function estimateVoiceCostUsd(kind: VoiceReceipt["kind"], provider: string, usage: { readonly seconds?: number; readonly characters?: number }): number {
  if (isLocalProvider(provider)) return 0;
  if (kind === "voice.stt") return provider === "openai" ? Math.round(((usage.seconds ?? 0) / 60) * 0.006 * 1e6) / 1e6 : 0;
  const characters = usage.characters ?? 0;
  if (provider === "openai") return Math.round(characters * 0.000015 * 1e6) / 1e6;
  if (provider === "elevenlabs") return Math.round(characters * 0.0003 * 1e6) / 1e6;
  return 0;
}

async function recordVoiceReceipt(input: Omit<VoiceReceipt, "id" | "createdAt">, cwd = process.cwd()): Promise<void> {
  const receipt: VoiceReceipt = {
    id: `voice_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input,
    ...(input.transcriptPreview !== undefined ? { transcriptPreview: input.transcriptPreview.slice(0, 200) } : {}),
  };
  try {
    const path = voiceLedgerPath(cwd);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // A receipt that cannot be written never fails the speech operation itself.
  }
}

export async function listVoiceReceipts(cwd = process.cwd()): Promise<VoiceReceipt[]> {
  const raw = await readFile(voiceLedgerPath(cwd), "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as VoiceReceipt);
}

// ---- Doctor -----------------------------------------------------------------------------

export interface VoiceDoctorTool {
  readonly name: string;
  readonly purpose: string;
  readonly path?: string;
}

export interface VoiceDoctorCheck {
  readonly provider: string;
  readonly status: "off" | "ok" | "fail";
  readonly detail: string;
}

export interface VoiceDoctorReport {
  readonly stt: VoiceDoctorCheck;
  readonly tts: VoiceDoctorCheck;
  readonly reply: VoiceReplyMode;
  readonly tools: readonly VoiceDoctorTool[];
  /** whisper.cpp ggml models found in the usual places. */
  readonly models: readonly string[];
  /** The config that turns local speech on with what was found, when anything is missing from the current config. */
  readonly suggestedConfig?: { readonly voice: VoiceConfig };
  /** `suggestedConfig` as the one line to paste into .muster/config.json. */
  readonly suggestedLine?: string;
  readonly hints: readonly string[];
}

const DOCTOR_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ["whisper-cli", "local speech-to-text (whisper.cpp)"],
  ["ffmpeg", "audio conversion"],
  ["say", "local text-to-speech (macOS)"],
  ["afplay", "playback for `muster voice say`"],
];

function modelDirs(env: VoiceEnv): string[] {
  const home = env.HOME ?? process.env.HOME ?? "";
  const dirs = [join(home, ".muster", "models"), join(home, ".cache", "whisper"), join(home, ".cache", "whisper.cpp")];
  // Tools that bundle whisper keep models under ~/.cache/<tool>/whisper[/models].
  try {
    for (const entry of readdirSync(join(home, ".cache"), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("whisper")) continue;
      dirs.push(join(home, ".cache", entry.name, "whisper", "models"), join(home, ".cache", entry.name, "whisper"));
    }
  } catch {
    // no ~/.cache
  }
  dirs.push("/opt/homebrew/share/whisper-cpp/models", "/usr/local/share/whisper-cpp/models", "/usr/share/whisper-cpp/models");
  return dirs;
}

/** whisper.cpp ggml model files in the usual places, smallest-English-first is not assumed: order is discovery order. */
export function findWhisperModels(env: VoiceEnv = process.env): string[] {
  const found: string[] = [];
  for (const dir of modelDirs(env)) {
    try {
      for (const name of readdirSync(dir).sort()) {
        if (/^ggml-.+\.bin$/.test(name) && !name.includes("encoder")) found.push(join(dir, name));
      }
    } catch {
      // missing dir
    }
  }
  return [...new Set(found)];
}

/** Render a value as one readable JSON line: `{"a": 1, "b": {"c": "d"}}`. */
export function inlineJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => `${JSON.stringify(key)}: ${inlineJson(entry)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

function sttCheck(voice: VoiceConfig | undefined, env: VoiceEnv): VoiceDoctorCheck {
  const stt = voice?.stt;
  if (!stt || stt.provider === "off") return { provider: "off", status: "off", detail: "voice notes get a setup hint instead of a turn" };
  const ffmpeg = findExecutable(voice?.ffmpeg ?? "ffmpeg", env);
  if (stt.provider === "whisper-cpp") {
    const binary = findExecutable(stt.binary ?? "whisper-cli", env);
    const model = stt.model ? expandHome(stt.model, env) : undefined;
    const problems = [
      ...(binary ? [] : [`${stt.binary ?? "whisper-cli"} not found (brew install whisper-cpp)`]),
      ...(!model ? ["voice.stt.model is not set"] : existsSync(model) ? [] : [`model ${model} does not exist`]),
      ...(ffmpeg ? [] : ["ffmpeg not found (brew install ffmpeg)"]),
    ];
    return problems.length
      ? { provider: stt.provider, status: "fail", detail: problems.join("; ") }
      : { provider: stt.provider, status: "ok", detail: `local, ${binary} with ${model}` };
  }
  if (stt.provider === "command") {
    const program = stt.command?.[0];
    if (!program) return { provider: stt.provider, status: "fail", detail: "voice.stt.command is empty" };
    return findExecutable(program, env)
      ? { provider: stt.provider, status: "ok", detail: `local, ${program}` }
      : { provider: stt.provider, status: "fail", detail: `${program} not found on PATH` };
  }
  if (stt.provider === "openai") return cloudCheck(stt.provider, stt.apiKeyEnv, trimBase(stt.baseUrl, "https://api.openai.com/v1"), env);
  return { provider: String(stt.provider), status: "fail", detail: "unknown provider (whisper-cpp, command, openai)" };
}

function ttsCheck(voice: VoiceConfig | undefined, env: VoiceEnv): VoiceDoctorCheck {
  const tts = voice?.tts;
  if (!tts || tts.provider === "off") return { provider: "off", status: "off", detail: "replies are text only" };
  const ffmpeg = findExecutable(voice?.ffmpeg ?? "ffmpeg", env);
  if (tts.provider === "say") {
    const binary = findExecutable(tts.binary ?? "say", env);
    const problems = [
      ...(binary ? [] : ["say not found (macOS only; use the command provider with piper, or a cloud provider)"]),
      ...(ffmpeg ? [] : ["ffmpeg not found (brew install ffmpeg)"]),
    ];
    return problems.length ? { provider: tts.provider, status: "fail", detail: problems.join("; ") } : { provider: tts.provider, status: "ok", detail: `local, ${binary}${tts.voice ? ` voice ${tts.voice}` : ""}` };
  }
  if (tts.provider === "command") {
    const program = tts.command?.[0];
    if (!program) return { provider: tts.provider, status: "fail", detail: "voice.tts.command is empty" };
    return findExecutable(program, env)
      ? { provider: tts.provider, status: "ok", detail: `local, ${program}` }
      : { provider: tts.provider, status: "fail", detail: `${program} not found on PATH` };
  }
  if (tts.provider === "openai") return cloudCheck(tts.provider, tts.apiKeyEnv, trimBase(tts.baseUrl, "https://api.openai.com/v1"), env);
  if (tts.provider === "elevenlabs") {
    if (!tts.voice) return { provider: tts.provider, status: "fail", detail: "voice.tts.voice (an ElevenLabs voice id) is not set" };
    return cloudCheck(tts.provider, tts.apiKeyEnv, trimBase(tts.baseUrl, "https://api.elevenlabs.io/v1"), env);
  }
  return { provider: String(tts.provider), status: "fail", detail: "unknown provider (say, command, openai, elevenlabs)" };
}

function cloudCheck(provider: string, apiKeyEnv: string | undefined, baseUrl: string, env: VoiceEnv): VoiceDoctorCheck {
  if (!apiKeyEnv) return { provider, status: "fail", detail: "apiKeyEnv is not set (the NAME of the env var holding the key)" };
  const value = env[apiKeyEnv];
  return value
    ? { provider, status: "ok", detail: `cloud, ${baseUrl}, key from env ${apiKeyEnv}` }
    : { provider, status: "fail", detail: `environment variable ${apiKeyEnv} is not set` };
}

/** What speech can run here. Reads the filesystem only; never makes a network call. */
export function voiceDoctor(options: { readonly voice: VoiceConfig | undefined; readonly env?: VoiceEnv }): VoiceDoctorReport {
  const env = options.env ?? process.env;
  const tools = DOCTOR_TOOLS.map(([name, purpose]) => ({ name, purpose, path: findExecutable(name, env) }));
  const models = findWhisperModels(env);
  const configuredModel = options.voice?.stt?.model ? expandHome(options.voice.stt.model, env) : undefined;
  if (configuredModel && existsSync(configuredModel) && !models.includes(configuredModel)) models.unshift(configuredModel);
  const stt = sttCheck(options.voice, env);
  const tts = ttsCheck(options.voice, env);
  const has = (name: string) => tools.some((tool) => tool.name === name && tool.path);
  const suggested: { stt?: VoiceSttConfig; tts?: VoiceTtsConfig } = {};
  const hints: string[] = [];
  if (stt.status !== "ok") {
    if (has("whisper-cli") && models[0]) suggested.stt = { provider: "whisper-cpp", model: models[0] };
    else if (!has("whisper-cli")) hints.push("Local speech-to-text needs whisper.cpp: brew install whisper-cpp");
    else hints.push("Download a whisper model, e.g. ggml-small.en.bin from https://huggingface.co/ggerganov/whisper.cpp, into ~/.muster/models");
  }
  if (tts.status !== "ok") {
    if (has("say")) suggested.tts = { provider: "say" };
    else hints.push("Local text-to-speech: on macOS `say` is built in; elsewhere use the command provider with a TTS that takes the text as an argument and writes {output}, or configure openai/elevenlabs with apiKeyEnv.");
  }
  if (!has("ffmpeg")) hints.push("Audio conversion needs ffmpeg: brew install ffmpeg");
  const voice: VoiceConfig | undefined = suggested.stt || suggested.tts
    ? { ...(options.voice ?? {}), ...(suggested.stt ? { stt: suggested.stt } : {}), ...(suggested.tts ? { tts: suggested.tts } : {}) }
    : undefined;
  return {
    stt,
    tts,
    reply: options.voice?.reply ?? "off",
    tools,
    models,
    ...(voice ? { suggestedConfig: { voice }, suggestedLine: `"voice": ${inlineJson(voice)}` } : {}),
    hints,
  };
}
