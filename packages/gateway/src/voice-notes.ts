import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  limitMessage,
  sizeLimitMessage,
  synthesize,
  sttEnabled,
  transcribe,
  ttsEnabled,
  VOICE_DEFAULTS,
  VoiceLimitError,
} from "@musterhq/core";
import type { MusterConfig, VoiceConfig } from "@musterhq/core";
import type { ChannelVoiceAudio } from "./channel-sdk.js";
import { isPairingChallenge } from "./envelope.js";
import type { PairingChallenge, SurfaceAttachment, SurfaceMessage, SurfaceReply } from "./envelope.js";
import { resolvePairing } from "./pairing.js";

/**
 * The shared voice path (docs/spec/clauses/21-voice.md). Adapters only expose
 * audio as attachments with seconds/size metadata and know how to download
 * and send it. Everything else lives here and is called from both the SDK
 * runner (channel-runner.ts) and the Telegram webhook handler (server.ts):
 *
 *   inbound:  limits → download → transcribe → the transcript becomes the prompt
 *   outbound: a 🎙 echo of what was heard, then (opt-in) a spoken copy of the reply
 */

export const VOICE_SETUP_HINT =
  "Voice notes need speech-to-text, which is off on this Muster. An operator can turn it on: run `muster voice doctor` and add the config line it prints.";

export type VoiceInboundStep =
  /** No audio (or nothing to do): run the message as it is. */
  | { readonly kind: "pass"; readonly message: SurfaceMessage }
  /** The transcript is now the prompt; `message.voice` is set. */
  | { readonly kind: "prompt"; readonly message: SurfaceMessage }
  /** Answer with `text` and start no turn. */
  | { readonly kind: "refuse"; readonly text: string };

export interface VoiceInboundDeps {
  readonly config: MusterConfig;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
  /** Platform download for attachments that carry a url (from the channel adapter). */
  readonly download?: (attachment: SurfaceAttachment, options: { readonly maxBytes: number }) => Promise<Uint8Array>;
  /** The channel's own policy already admitted the sender (no per-sender pairing). */
  readonly preAuthorized?: boolean;
}

const AUDIO_EXT = /\.(ogg|oga|opus|mp3|m4a|aac|wav|webm|flac|aiff?|amr)$/i;

export function isAudioAttachment(attachment: SurfaceAttachment): boolean {
  return attachment.mime.toLowerCase().startsWith("audio/") || AUDIO_EXT.test(attachment.name);
}

function extensionFor(attachment: SurfaceAttachment): string {
  const named = AUDIO_EXT.exec(attachment.name)?.[1];
  if (named) return named.toLowerCase();
  const mime = attachment.mime.toLowerCase();
  if (mime.includes("ogg") || mime.includes("opus")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  return "audio";
}

function limits(voice: VoiceConfig | undefined) {
  return {
    maxSeconds: voice?.maxSeconds ?? VOICE_DEFAULTS.maxSeconds,
    maxBytes: voice?.maxBytes ?? VOICE_DEFAULTS.maxBytes,
  };
}

/** Turn a message's audio into its prompt, or say why not. Never throws for a user-caused problem. */
export async function prepareVoiceInbound(message: SurfaceMessage, deps: VoiceInboundDeps): Promise<VoiceInboundStep> {
  const audio = (message.attachments ?? []).filter(isAudioAttachment);
  if (!audio.length) return { kind: "pass", message };
  // Strangers get the pairing challenge; nothing is downloaded or transcribed for them.
  if (!deps.preAuthorized && !await resolvePairing(message.surfaceId, message.senderId, deps.cwd)) {
    return { kind: "pass", message: message.text.trim() ? message : { ...message, text: "[voice note]" } };
  }
  const voice = deps.config.voice;
  if (!sttEnabled(voice)) {
    return message.text.trim() ? { kind: "pass", message } : { kind: "refuse", text: VOICE_SETUP_HINT };
  }
  const { maxSeconds, maxBytes } = limits(voice);
  // Every limit is checked on the platform's metadata before any download or provider runs.
  for (const attachment of audio) {
    if (attachment.seconds !== undefined && attachment.seconds > maxSeconds) return { kind: "refuse", text: limitMessage(attachment.seconds, maxSeconds) };
    if (attachment.sizeBytes !== undefined && attachment.sizeBytes > maxBytes) return { kind: "refuse", text: sizeLimitMessage(attachment.sizeBytes, maxBytes) };
  }
  const transcripts: string[] = [];
  let seconds = 0;
  let measured = true;
  const dir = await mkdtemp(join(tmpdir(), "muster-voice-in-"));
  try {
    for (const [index, attachment] of audio.entries()) {
      let bytes: Uint8Array;
      try {
        if (attachment.bytes) bytes = Buffer.from(attachment.bytes, "base64");
        else if (attachment.url && deps.download) bytes = await deps.download(attachment, { maxBytes });
        else return { kind: "refuse", text: "I couldn't fetch that voice note from this channel." };
      } catch (error) {
        // A platform size reported before download is refused like the envelope's own size.
        if (error instanceof VoiceLimitError) return { kind: "refuse", text: error.message };
        deps.log?.(`voice: download failed: ${error instanceof Error ? error.message : String(error)}`);
        return { kind: "refuse", text: "I couldn't download that voice note. Please try again." };
      }
      if (bytes.length > maxBytes) return { kind: "refuse", text: sizeLimitMessage(bytes.length, maxBytes) };
      const file = join(dir, `voice-${index}.${extensionFor(attachment)}`);
      await writeFile(file, bytes, { mode: 0o600 });
      try {
        const result = await transcribe(file, { voice, cwd: deps.cwd, env: deps.env, maxSeconds, surfaceId: message.surfaceId });
        if (result.text) transcripts.push(result.text);
        const length = attachment.seconds ?? result.seconds;
        if (length === undefined) measured = false;
        else seconds += length;
      } catch (error) {
        if (error instanceof VoiceLimitError) return { kind: "refuse", text: error.message };
        const detail = error instanceof Error ? error.message : String(error);
        deps.log?.(`voice: transcription failed: ${detail}`);
        // Tool names, exit codes and local paths stay in the log, not the chat.
        return { kind: "refuse", text: "I couldn't transcribe that voice note. Please try again; if it keeps failing, the gateway log has the details." };
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const transcript = transcripts.join("\n\n").trim();
  if (!transcript) return { kind: "refuse", text: "I couldn't hear any words in that voice note." };
  const caption = message.text.trim();
  return {
    kind: "prompt",
    message: {
      ...message,
      text: caption ? `${caption}\n\n${transcript}` : transcript,
      voice: { ...(measured ? { seconds } : {}), transcript },
    },
  };
}

/** `🎙 "<transcript, ≤80 chars>"`: shows the user what was heard. */
export function voiceEchoLine(transcript: string): string {
  const flat = transcript.replace(/\s+/g, " ").trim();
  const shown = flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
  return `🎙 "${shown}"`;
}

/** Prefix the reply text with the echo when the prompt came from speech. */
export function withVoiceEcho<T extends SurfaceReply | PairingChallenge>(reply: T, message: SurfaceMessage): T {
  if (!message.voice || isPairingChallenge(reply)) return reply;
  const echo = voiceEchoLine(message.voice.transcript);
  return { ...reply, text: reply.text ? `${echo}\n\n${reply.text}` : echo };
}

/**
 * The part of a reply worth hearing: no code blocks, URLs, tables, MEDIA
 * lines or markdown marks, capped at `maxChars` on a sentence boundary.
 */
export function speakableText(text: string, maxChars: number = VOICE_DEFAULTS.maxReplyChars): string {
  const cleaned = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .split("\n")
    .filter((line) => !/^\s*\|/.test(line) && !/^\s*[-:|\s]{3,}$/.test(line) && !/^\s*MEDIA:/.test(line))
    .join("\n")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<?\bhttps?:\/\/[^\s>)]+>?/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  const window = cleaned.slice(0, maxChars);
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (sentence >= maxChars / 2) return window.slice(0, sentence + 1);
  const space = window.lastIndexOf(" ");
  return `${window.slice(0, space > maxChars / 2 ? space : maxChars - 1).trimEnd()}…`;
}

/** Whether this reply should also be spoken (voice.reply: mirror answers voice with voice, always answers everything). */
export function wantsSpokenReply(config: MusterConfig, message: SurfaceMessage, reply: SurfaceReply | PairingChallenge): boolean {
  const mode = config.voice?.reply ?? "off";
  if (mode === "off" || isPairingChallenge(reply) || reply.approvalRequest) return false;
  if (!ttsEnabled(config.voice)) return false;
  return mode === "always" || (mode === "mirror" && Boolean(message.voice));
}

/**
 * Speak the reply and hand the Ogg/Opus file to `send`. Best effort: a
 * speech failure is logged and never fails the (already delivered) text reply.
 */
export async function deliverSpokenReply(input: {
  readonly config: MusterConfig;
  readonly cwd: string;
  readonly message: SurfaceMessage;
  readonly reply: SurfaceReply | PairingChallenge;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
  readonly send: (audio: ChannelVoiceAudio) => Promise<unknown>;
}): Promise<boolean> {
  if (!wantsSpokenReply(input.config, input.message, input.reply) || isPairingChallenge(input.reply)) return false;
  // Speak the answer, not the echo of what was heard.
  const echo = input.message.voice ? voiceEchoLine(input.message.voice.transcript) : undefined;
  const answer = echo && input.reply.text.startsWith(echo) ? input.reply.text.slice(echo.length) : input.reply.text;
  const text = speakableText(answer, input.config.voice?.maxReplyChars ?? VOICE_DEFAULTS.maxReplyChars);
  if (!text) return false;
  let spoken: Awaited<ReturnType<typeof synthesize>> | undefined;
  try {
    spoken = await synthesize(text, { voice: input.config.voice, cwd: input.cwd, env: input.env, format: "ogg-opus", surfaceId: input.message.surfaceId });
    await input.send({ path: spoken.path, mime: spoken.mime });
    return true;
  } catch (error) {
    input.log?.(`voice: spoken reply failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    await spoken?.cleanup();
  }
}
