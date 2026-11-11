import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  configPath,
  defaultConfig,
  findExecutable,
  loadConfig,
  runSubprocess,
  synthesize,
  transcribe,
  voiceDoctor,
} from "@musterhq/core";
import type { MusterConfig, SynthesisFormat, VoiceConfig, VoiceDoctorReport } from "@musterhq/core";

/**
 * `muster voice doctor | transcribe <file> | say <text> [-o file]`
 * (docs/spec/clauses/21-voice.md). Speech is configured under `voice` in
 * .muster/config.json; keys are env-var names only.
 */

export const VOICE_USAGE = "Usage: muster voice doctor [--json] | transcribe <file> [--json] | say \"text\" [-o out.ogg|out.wav] [--voice Name]";

export async function loadVoiceConfig(cwd: string): Promise<VoiceConfig | undefined> {
  const config: MusterConfig = existsSync(configPath(cwd)) ? await loadConfig(cwd) : defaultConfig();
  return config.voice;
}

function flagValue(args: readonly string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) throw new Error(`${name} needs a value.`);
      return value;
    }
  }
  return undefined;
}

/** Positional arguments, skipping flags and the values of value flags. */
function positionals(args: readonly string[], valueFlags: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valueFlags.includes(arg)) { index += 1; continue; }
    if (arg.startsWith("-") && arg.length > 1) continue;
    out.push(arg);
  }
  return out;
}

/** The words to speak: everything except -o/--output, --voice and their values (so "-5 degrees" is text). */
function sayText(args: readonly string[]): string {
  const words: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-o" || arg === "--output" || arg === "--voice") { index += 1; continue; }
    if (arg === "--") { words.push(...args.slice(index + 1)); break; }
    words.push(arg);
  }
  return words.join(" ");
}

const STATUS_MARK: Record<string, string> = { ok: "on", off: "off", fail: "needs setup" };

/** `muster voice doctor` as a readable checklist. */
export function formatVoiceDoctor(report: VoiceDoctorReport, configFile: string): string[] {
  const rows: string[] = ["Voice"];
  const label = (text: string) => text.padEnd(16);
  for (const [name, check] of [["Speech-to-text", report.stt], ["Text-to-speech", report.tts]] as const) {
    const state = check.status === "off" ? "off" : `${check.provider} · ${STATUS_MARK[check.status]}`;
    rows.push(`  ${label(name)}${state.padEnd(Math.max(6, state.length + 2))}${check.detail}`.trimEnd());
  }
  rows.push(`  ${label("Spoken replies")}${report.reply}`);
  rows.push("", "On this machine");
  const width = Math.max(13, ...report.tools.map((tool) => tool.name.length)) + 2;
  for (const tool of report.tools) {
    rows.push(tool.path ? `  ✓ ${tool.name.padEnd(width)}${tool.path}` : `  ✗ ${tool.name.padEnd(width)}missing: ${tool.purpose}`);
  }
  if (report.models.length) for (const model of report.models) rows.push(`  ✓ ${"whisper model".padEnd(width)}${model}`);
  else rows.push(`  ✗ ${"whisper model".padEnd(width)}none found`);
  if (report.suggestedLine) {
    rows.push("", `Turn on local speech: add this at the top level of ${configFile}`, `  ${report.suggestedLine}`);
  }
  for (const hint of report.hints) rows.push("", `  → ${hint}`);
  return rows;
}

function formatForOutput(path: string): SynthesisFormat {
  if (/\.(ogg|oga|opus)$/i.test(path)) return "ogg-opus";
  if (/\.wav$/i.test(path)) return "wav";
  throw new Error(`Write .ogg (Opus) or .wav, not ${path}`);
}

async function play(path: string): Promise<void> {
  const afplay = findExecutable("afplay");
  if (afplay) {
    await runSubprocess(afplay, [path], { timeoutMs: 10 * 60_000 });
    return;
  }
  const ffplay = findExecutable("ffplay");
  if (ffplay) {
    await runSubprocess(ffplay, ["-nodisp", "-autoexit", "-loglevel", "error", path], { timeoutMs: 10 * 60_000 });
    return;
  }
  throw new Error("No audio player found (afplay or ffplay). Write a file instead: muster voice say \"text\" -o out.ogg");
}

export async function voiceCommand(args: readonly string[], cwd = process.cwd()): Promise<void> {
  const [sub, ...rest] = args;
  const voice = await loadVoiceConfig(cwd);
  if (sub === "doctor") {
    const report = voiceDoctor({ voice });
    if (rest.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const line of formatVoiceDoctor(report, configPath(cwd))) console.log(line);
    }
    if (report.stt.status === "fail" || report.tts.status === "fail") process.exitCode = 1;
    return;
  }
  if (sub === "transcribe") {
    const [file] = positionals(rest, []);
    if (!file) throw new Error(VOICE_USAGE);
    const result = await transcribe(resolve(cwd, file), { voice, cwd });
    console.log(rest.includes("--json") ? JSON.stringify(result, null, 2) : result.text);
    return;
  }
  if (sub === "say") {
    const output = flagValue(rest, "-o", "--output");
    const voiceName = flagValue(rest, "--voice");
    const text = sayText(rest);
    if (!text.trim()) throw new Error(VOICE_USAGE);
    const effective: VoiceConfig | undefined = voiceName && voice?.tts ? { ...voice, tts: { ...voice.tts, voice: voiceName } } : voice;
    if (output) {
      const path = resolve(cwd, output);
      await synthesize(text, { voice: effective, cwd, format: formatForOutput(path), output: path });
      console.log(path);
      return;
    }
    // afplay cannot play Ogg/Opus, so speak to a temp WAV, play it, remove it.
    const spoken = await synthesize(text, { voice: effective, cwd, format: "wav" });
    try {
      await play(spoken.path);
    } finally {
      await spoken.cleanup();
    }
    return;
  }
  throw new Error(VOICE_USAGE);
}
