import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExecutable, sttEnabled, transcribe } from "@musterhq/core";
import type { VoiceConfig, VoiceEnv } from "@musterhq/core";

/**
 * Push-to-talk dictation for the chat composer (docs/spec/clauses/22-dictation.md).
 *
 * Ctrl+R starts recording from the default microphone with sox `rec` (or
 * ffmpeg as a fallback); Ctrl+R or Enter stops it, Esc cancels it. The clip is
 * transcribed with the configured `voice.stt` provider and the text is
 * inserted at the composer cursor. It is never sent on its own.
 *
 * The recorder is spawned with an argv array and no shell. The clip lives in a
 * mkdtemp dir that is always removed.
 */

export const DICTATION_DEFAULT_MAX_SECONDS = 120;
const LEVEL_BARS = "▁▂▃▄▅▆▇█";
const STOP_GRACE_MS = 3000;
/** Esc can arrive twice (the raw stdin hook and the TUI's delayed lone-Esc); the second is the same press. */
const ESCAPE_DEDUPE_MS = 500;

export interface DictationOptions {
  /** Read at each start, so a config change applies without restarting chat. */
  readonly voice: () => VoiceConfig | undefined | Promise<VoiceConfig | undefined>;
  readonly cwd?: string;
  /** Where the recorder and STT tools are found (PATH). Defaults to process.env. */
  readonly env?: VoiceEnv;
  readonly platform?: NodeJS.Platform;
  /** Clock for the elapsed timer (tests). */
  readonly now?: () => number;
  /** Repaint interval for the recording row (default 200 ms). */
  readonly tickMs?: number;
}

/** Where dictation paints: the row above the composer, the composer itself, and dim notes. */
export interface DictationHost {
  setRow(row: string): void;
  insert(text: string): void;
  note(line: string): void;
}

export interface RecorderCommand {
  readonly kind: "rec" | "ffmpeg";
  readonly binary: string;
  readonly args: readonly string[];
  /** Extra environment (sox reads the input device from AUDIODEV). */
  readonly env?: Readonly<Record<string, string>>;
}

/** sox `rec` first, then ffmpeg's avfoundation (macOS) or pulse (Linux) input. */
export function resolveRecorder(voice: VoiceConfig | undefined, wav: string, env: VoiceEnv, platform: NodeJS.Platform = process.platform): RecorderCommand | undefined {
  const input = voice?.dictation?.input;
  const rec = findExecutable("rec", env);
  if (rec) {
    return { kind: "rec", binary: rec, args: ["-q", "-c", "1", "-r", "16000", "-b", "16", wav], env: input ? { AUDIODEV: input } : undefined };
  }
  const ffmpeg = findExecutable(voice?.ffmpeg ?? "ffmpeg", env);
  if (!ffmpeg) return undefined;
  const source = platform === "darwin"
    ? ["-f", "avfoundation", "-i", `:${input ?? "0"}`]
    : ["-f", "pulse", "-i", input ?? "default"];
  return {
    kind: "ffmpeg",
    binary: ffmpeg,
    args: ["-hide_banner", "-loglevel", "error", "-nostats", "-y", ...source, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
  };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** RMS of 16-bit PCM samples, 0..1. */
export function pcmLevel(bytes: Buffer): number {
  const count = Math.floor(bytes.length / 2);
  if (!count) return 0;
  let sum = 0;
  for (let index = 0; index < count; index += 1) {
    const sample = bytes.readInt16LE(index * 2) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / count);
}

/** One meter glyph: -60 dBFS and below is the lowest bar, 0 dBFS the highest. */
export function levelBar(level: number): string {
  if (level <= 0) return LEVEL_BARS[0]!;
  const db = 20 * Math.log10(level);
  const index = Math.round(((Math.max(-60, Math.min(0, db)) + 60) / 60) * (LEVEL_BARS.length - 1));
  return LEVEL_BARS[index]!;
}

export function formatRecordingRow(elapsedMs: number, levels: readonly number[]): string {
  const meter = [...Array.from({ length: Math.max(0, 3 - levels.length) }, () => 0), ...levels.slice(-3)].map(levelBar).join("");
  return `\x1b[38;2;255;107;122m●\x1b[0m Recording ${formatElapsed(elapsedMs)} ${meter} \x1b[2m· ctrl+r stop · esc cancel\x1b[0m`;
}

/** The last ~100 ms of PCM in a WAV that is still being written. */
async function wavTail(path: string): Promise<Buffer> {
  const size = await stat(path).then((info) => info.size).catch(() => 0);
  if (size <= 44) return Buffer.alloc(0);
  const length = Math.min(3200, size - 44) & ~1;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer;
  } finally {
    await handle.close();
  }
}

type DictationState = "idle" | "starting" | "recording" | "transcribing";

interface Session {
  readonly dir: string;
  readonly wav: string;
  readonly voice: VoiceConfig | undefined;
  readonly env: VoiceEnv;
  child?: ChildProcess;
  kind?: RecorderCommand["kind"];
  exited?: Promise<void>;
  startedAt: number;
  levels: number[];
  ticker?: ReturnType<typeof setInterval>;
  limit?: ReturnType<typeof setTimeout>;
  stderr: string;
}

export class Dictation {
  private state: DictationState = "idle";
  private session: Session | undefined;
  private cycle: Promise<void> = Promise.resolve();
  private finishCycle: (() => void) | undefined;
  /** Set when the user stopped (or cancelled) before the recorder was up. */
  private pending: "stop" | "cancel" | undefined;
  private escapeAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: DictationOptions, private readonly host: DictationHost) {}

  /** True from Ctrl+R until the clip is stopped or cancelled. */
  get recording(): boolean {
    return this.state === "starting" || this.state === "recording";
  }

  get busy(): boolean {
    return this.state !== "idle";
  }

  /** Resolves when the current recording has been inserted, cancelled or failed. */
  done(): Promise<void> {
    return this.cycle;
  }

  /** Ctrl+R: start when idle, stop when recording. */
  toggle(): void {
    if (this.state === "idle") void this.start();
    else if (this.recording) void this.stop();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private beginCycle(): void {
    this.pending = undefined;
    this.cycle = new Promise<void>((resolve) => { this.finishCycle = resolve; });
  }

  private endCycle(): void {
    this.state = "idle";
    this.session = undefined;
    this.host.setRow("");
    const finish = this.finishCycle;
    this.finishCycle = undefined;
    finish?.();
  }

  async start(): Promise<void> {
    if (this.state !== "idle") return;
    this.state = "starting";
    this.beginCycle();
    const env = this.options.env ?? process.env;
    let voice: VoiceConfig | undefined;
    try {
      voice = await this.options.voice();
    } catch (error) {
      this.host.note(`Dictation could not read the voice config: ${message(error)}`);
      this.endCycle();
      return;
    }
    // Nothing is spawned and no file is made until both halves exist.
    if (!sttEnabled(voice)) {
      this.host.note("Dictation needs speech-to-text: run muster voice doctor");
      this.endCycle();
      return;
    }
    const platform = this.options.platform ?? process.platform;
    if (!resolveRecorder(voice, "", env, platform)) {
      this.host.note(`Dictation needs a recorder: ${platform === "darwin" ? "brew install sox" : "install sox (apt install sox)"}`);
      this.endCycle();
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "muster-dictation-"));
    const wav = join(dir, "dictation.wav");
    const recorder = resolveRecorder(voice, wav, env, platform)!;
    const session: Session = { dir, wav, voice, env, startedAt: this.now(), levels: [], stderr: "" };
    this.session = session;
    const child = spawn(recorder.binary, [...recorder.args], {
      env: { ...env, ...recorder.env } as NodeJS.ProcessEnv,
      stdio: [recorder.kind === "ffmpeg" ? "pipe" : "ignore", "ignore", "pipe"],
    });
    session.child = child;
    session.kind = recorder.kind;
    child.stderr?.on("data", (chunk: Buffer) => { session.stderr = (session.stderr + chunk.toString("utf8")).slice(-2000); });
    session.exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", (error) => {
        session.stderr += message(error);
        resolve();
      });
    });
    void session.exited.then(() => this.recorderExited(session));
    this.state = "recording";
    this.paintRecording(session);
    session.ticker = setInterval(() => { void this.sample(session); }, this.options.tickMs ?? 200);
    session.ticker.unref?.();
    const maxSeconds = voice?.dictation?.maxSeconds ?? DICTATION_DEFAULT_MAX_SECONDS;
    session.limit = setTimeout(() => {
      if (this.session !== session || this.state !== "recording") return;
      this.host.note(`stopped at the ${maxSeconds} s limit`);
      void this.stop();
    }, Math.max(0, maxSeconds * 1000));
    session.limit.unref?.();
    if (this.pending === "stop") void this.stop();
    else if (this.pending === "cancel") void this.cancel();
  }

  private paintRecording(session: Session): void {
    if (this.session !== session || this.state !== "recording") return;
    this.host.setRow(formatRecordingRow(this.now() - session.startedAt, session.levels));
  }

  private async sample(session: Session): Promise<void> {
    const tail = await wavTail(session.wav).catch(() => Buffer.alloc(0));
    if (tail.length) {
      session.levels.push(pcmLevel(tail));
      if (session.levels.length > 3) session.levels.shift();
    }
    this.paintRecording(session);
  }

  /** The recorder died on its own (no device, permission denied). */
  private recorderExited(session: Session): void {
    if (this.session !== session || this.state !== "recording") return;
    if (session.ticker) clearInterval(session.ticker);
    if (session.limit) clearTimeout(session.limit);
    const detail = session.stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 300);
    this.host.note(`Dictation stopped: the recorder exited${detail ? `: ${detail}` : ""}`);
    void rm(session.dir, { recursive: true, force: true }).finally(() => this.endCycle());
  }

  /** Stop the recorder and wait for it to finish the file. */
  private async halt(session: Session): Promise<void> {
    if (session.ticker) clearInterval(session.ticker);
    if (session.limit) clearTimeout(session.limit);
    const child = session.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (session.kind === "ffmpeg" && child.stdin) {
      child.stdin.end("q");
    } else {
      child.kill("SIGINT");
    }
    const killer = setTimeout(() => { child.kill("SIGKILL"); }, STOP_GRACE_MS);
    killer.unref?.();
    await session.exited;
    clearTimeout(killer);
  }

  /** Esc while recording: stop the recorder and discard the clip. Nothing is transcribed. */
  async cancel(): Promise<boolean> {
    if (this.state === "starting") {
      this.pending = "cancel";
      return true;
    }
    const session = this.session;
    if (!session || this.state !== "recording") return false;
    this.state = "transcribing";
    try {
      await this.halt(session);
    } finally {
      await rm(session.dir, { recursive: true, force: true });
      this.endCycle();
    }
    return true;
  }

  /**
   * Esc: true when it belonged to dictation (it cancelled a recording, or is
   * the duplicate delivery of the press that did). A running turn is then left
   * alone: Esc never both cancels a recording and interrupts the turn.
   */
  handleEscape(now = Date.now()): boolean {
    if (this.recording) {
      this.escapeAt = now;
      void this.cancel();
      return true;
    }
    return now - this.escapeAt <= ESCAPE_DEDUPE_MS;
  }

  /** Ctrl+R or Enter while recording: stop, transcribe, insert at the cursor. */
  async stop(): Promise<void> {
    if (this.state === "starting") {
      this.pending = "stop";
      return;
    }
    const session = this.session;
    if (!session || this.state !== "recording") return;
    this.state = "transcribing";
    this.host.setRow("\x1b[2mTranscribing…\x1b[0m");
    try {
      await this.halt(session);
      const result = await transcribe(session.wav, {
        voice: session.voice,
        env: session.env,
        cwd: this.options.cwd,
        surfaceId: "chat",
      });
      if (result.text) this.host.insert(result.text);
      else this.host.note("Dictation heard no speech.");
    } catch (error) {
      this.host.note(`Dictation failed: ${message(error)}`);
    } finally {
      await rm(session.dir, { recursive: true, force: true });
      this.endCycle();
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Insert dictated text at the cursor, with a space when it would touch a word. */
export function dictationInsertText(before: string, text: string): string {
  return before && !/\s$/.test(before) ? ` ${text}` : text;
}
