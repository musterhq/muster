import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Fake speech binaries for tests: whisper-cli, ffmpeg, say, afplay and two
 * command providers. Each is a small node script that appends its argv (one
 * JSON line) to $FAKE_VOICE_LOG and does just enough file work for the real
 * code path: ffmpeg writes a WAV of $FAKE_WAV_SECONDS (default 2) seconds or
 * an Ogg stub, say writes an AIFF stub, whisper-cli prints a timestamped
 * transcript ($FAKE_TRANSCRIPT) for its -f input, and rec (sox) records a
 * 16 kHz mono WAV of a tone to its last argument until SIGINT, logging the
 * signal it got as a `rec:signal` call.
 */

export interface FakeVoiceCall {
  readonly tool: string;
  readonly argv: readonly string[];
  /** Whether each path-like argument existed when the tool ran. */
  readonly existed: Record<string, boolean>;
  readonly pid?: number;
}

const PRELUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const existed = {};
for (const arg of argv) if (arg.startsWith("/")) existed[arg] = fs.existsSync(arg);
if (process.env.FAKE_VOICE_LOG) fs.appendFileSync(process.env.FAKE_VOICE_LOG, JSON.stringify({ tool: TOOL, argv, existed, pid: process.pid }) + "\\n");
const after = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
`;

const SCRIPTS: Record<string, string> = {
  "whisper-cli": `
const input = after("-f");
if (!input || !fs.existsSync(input)) { process.stderr.write("error: input file not found\\n"); process.exit(2); }
if (!after("-m") || !fs.existsSync(after("-m"))) { process.stderr.write("error: failed to load model\\n"); process.exit(3); }
const text = process.env.FAKE_TRANSCRIPT ?? "what is two plus two";
process.stdout.write("[00:00:00.000 --> 00:00:02.000]   " + text + "\\n[00:00:02.000 --> 00:00:03.000]   [BLANK_AUDIO]\\n");
`,
  ffmpeg: `
const output = argv[argv.length - 1];
if (process.env.FAKE_FFMPEG_FAIL) { process.stderr.write("ffmpeg: Invalid data found when processing input\\n"); process.exit(1); }
if (output.endsWith(".wav")) {
  const seconds = Number(process.env.FAKE_WAV_SECONDS ?? "2");
  const data = Buffer.alloc(Math.round(seconds * 32000));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(output, Buffer.concat([header, data]));
} else {
  fs.writeFileSync(output, Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]));
}
`,
  say: `
const output = after("-o");
if (output) fs.writeFileSync(output, Buffer.concat([Buffer.from("FORM"), Buffer.alloc(40)]));
`,
  afplay: ``,
  rec: `
const output = argv[argv.length - 1];
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write("data", 36);
fs.writeFileSync(output, header);
let samples = 0;
const chunk = () => {
  const data = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i += 1) data.writeInt16LE(Math.round(8000 * Math.sin(((samples + i) / 16000) * 2 * Math.PI * 440)), i * 2);
  samples += 1600;
  fs.appendFileSync(output, data);
};
chunk();
const timer = setInterval(chunk, 100);
process.on("SIGINT", () => {
  clearInterval(timer);
  if (process.env.FAKE_VOICE_LOG) fs.appendFileSync(process.env.FAKE_VOICE_LOG, JSON.stringify({ tool: "rec:signal", argv: ["SIGINT"], existed: {} }) + "\\n");
  const size = fs.statSync(output).size;
  const fd = fs.openSync(output, "r+");
  const sizes = Buffer.alloc(4);
  sizes.writeUInt32LE(size - 8, 0); fs.writeSync(fd, sizes, 0, 4, 4);
  sizes.writeUInt32LE(size - 44, 0); fs.writeSync(fd, sizes, 0, 4, 40);
  fs.closeSync(fd);
  process.exit(0);
});
// Listening for SIGINT from here on: tests that stop or cancel wait for this line.
if (process.env.FAKE_VOICE_LOG) fs.appendFileSync(process.env.FAKE_VOICE_LOG, JSON.stringify({ tool: "rec:ready", argv: [], existed: {} }) + "\\n");
`,
  "my-stt": `
const input = argv[0];
if (!input || !fs.existsSync(input)) { process.stderr.write("my-stt: no input\\n"); process.exit(4); }
process.stdout.write("  command transcript  \\n");
`,
  "my-tts": `
if (process.env.FAKE_TTS_FAIL) { process.stderr.write("line one\\nmy-tts: voice not installed\\n"); process.exit(5); }
fs.writeFileSync(argv[1], "RIFF" + argv[0]);
`,
};

/** Write the fake tools into `dir` and return the path of the call log. */
export async function installFakeVoiceTools(dir: string, only?: readonly string[]): Promise<{ readonly bin: string; readonly log: string }> {
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  for (const [name, body] of Object.entries(SCRIPTS)) {
    if (only && !only.includes(name)) continue;
    const path = join(bin, name);
    await writeFile(path, `${PRELUDE.replace("TOOL", JSON.stringify(name))}${body}`, "utf8");
    await chmod(path, 0o755);
  }
  return { bin, log: join(dir, "calls.jsonl") };
}

export async function readFakeVoiceCalls(log: string): Promise<FakeVoiceCall[]> {
  const raw = await readFile(log, "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeVoiceCall);
}
