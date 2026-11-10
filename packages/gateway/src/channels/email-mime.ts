/**
 * Just enough RFC 5322 / MIME for a chat channel: parse headers, find the
 * text part (decoding base64 / quoted-printable / charsets), and build a
 * plain-text reply with threading headers.
 */

export interface ParsedEmail {
  readonly messageId?: string;
  readonly from?: string;
  readonly fromName?: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly autoSubmitted?: string;
  readonly precedence?: string;
  readonly listId?: string;
  readonly text: string;
}

interface Part {
  readonly headers: Map<string, string>;
  readonly body: string; // latin1-preserved bytes
}

function splitHeaders(raw: string): Part {
  const match = /\r?\n\r?\n/.exec(raw);
  const head = match ? raw.slice(0, match.index) : raw;
  const body = match ? raw.slice(match.index + match[0].length) : "";
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function decodeBytes(latin1: string, charset: string | undefined): string {
  const bytes = Buffer.from(latin1, "latin1");
  try {
    return new TextDecoder((charset ?? "utf-8").toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function decodeQuotedPrintable(value: string): string {
  return value.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** RFC 2047 encoded words in headers. */
export function decodeHeaderWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, encoding: string, text: string) => {
      const latin1 = encoding.toUpperCase() === "B"
        ? Buffer.from(text, "base64").toString("latin1")
        : decodeQuotedPrintable(text.replace(/_/g, " "));
      return decodeBytes(latin1, charset);
    });
}

function headerParam(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(value);
  return match ? (match[1] ?? match[2]) : undefined;
}

function partText(part: Part): { readonly plain?: string; readonly html?: string } {
  const type = (part.headers.get("content-type") ?? "text/plain").toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = headerParam(part.headers.get("content-type"), "boundary");
    if (!boundary) return {};
    let plain: string | undefined;
    let html: string | undefined;
    const sections = part.body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*\\r?\\n?`));
    for (const section of sections.slice(1)) {
      if (!section.trim()) continue;
      const found = partText(splitHeaders(section));
      plain ??= found.plain;
      html ??= found.html;
    }
    return { plain, html };
  }
  if ((part.headers.get("content-disposition") ?? "").toLowerCase().startsWith("attachment")) return {};
  const encoding = (part.headers.get("content-transfer-encoding") ?? "7bit").toLowerCase();
  const bytes = encoding === "base64"
    ? Buffer.from(part.body.replace(/\s+/g, ""), "base64").toString("latin1")
    : encoding === "quoted-printable" ? decodeQuotedPrintable(part.body) : part.body;
  const text = decodeBytes(bytes, headerParam(part.headers.get("content-type"), "charset"));
  if (type.startsWith("text/plain")) return { plain: text };
  if (type.startsWith("text/html")) return { html: text };
  return {};
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Remove the quoted earlier conversation and the signature from a reply. */
export function stripQuotedReply(text: string): string {
  const kept: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^On .{1,200}wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(line.trim()) || line === "-- ") break;
    if (line.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function messageIds(value: string | undefined): string[] {
  return value?.match(/<[^<>\s]+>/g) ?? [];
}

function addressOf(value: string | undefined): { readonly address?: string; readonly name?: string } {
  if (!value) return {};
  const angle = /^(.*)<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
  if (angle) return { address: angle[2].toLowerCase(), name: decodeHeaderWords(angle[1].trim().replace(/^"|"$/g, "")) || undefined };
  const bare = /([^\s<>,;]+@[^\s<>,;]+)/.exec(value);
  return { address: bare?.[1]?.toLowerCase() };
}

export function parseEmailMessage(raw: string | Buffer): ParsedEmail {
  const top = splitHeaders(typeof raw === "string" ? Buffer.from(raw, "utf8").toString("latin1") : raw.toString("latin1"));
  const header = (name: string) => {
    const value = top.headers.get(name);
    return value === undefined ? undefined : decodeHeaderWords(decodeBytes(value, "utf-8"));
  };
  const from = addressOf(header("from"));
  const found = partText(top);
  const text = found.plain ?? (found.html ? htmlToText(found.html) : "");
  return {
    messageId: messageIds(header("message-id"))[0],
    from: from.address,
    fromName: from.name,
    to: (header("to") ?? "").split(",").map((entry) => addressOf(entry).address).filter((entry): entry is string => Boolean(entry)),
    subject: header("subject") ?? "",
    inReplyTo: messageIds(header("in-reply-to"))[0],
    references: messageIds(header("references")),
    autoSubmitted: header("auto-submitted")?.toLowerCase(),
    precedence: header("precedence")?.toLowerCase(),
    listId: header("list-id"),
    text: text.replace(/\r\n/g, "\n"),
  };
}

function encodeQuotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    let encoded = "";
    const bytes = Buffer.from(line, "utf8");
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      const last = index === bytes.length - 1;
      const literal = (byte >= 33 && byte <= 126 && byte !== 61) || ((byte === 32 || byte === 9) && !last);
      encoded += literal ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    while (encoded.length > 76) {
      let cut = 75;
      // Do not split an =XX escape.
      const escape = encoded.lastIndexOf("=", cut);
      if (escape > cut - 3) cut = escape;
      out.push(`${encoded.slice(0, cut)}=`);
      encoded = encoded.slice(cut);
    }
    out.push(encoded);
  }
  return out.join("\r\n");
}

function encodeHeaderWord(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

export function replySubject(subject: string): string {
  const clean = subject.trim() || "Message from Muster";
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

export function buildEmail(input: {
  readonly from: string;
  readonly fromName?: string;
  readonly to: string;
  readonly subject: string;
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly text: string;
  readonly date?: Date;
}): string {
  for (const value of [input.from, input.to, input.messageId, input.inReplyTo ?? "", ...(input.references ?? [])]) {
    if (/[\r\n]/.test(value)) throw new Error("email header values must not contain line breaks");
  }
  const lines = [
    `From: ${input.fromName ? `${encodeHeaderWord(input.fromName)} <${input.from}>` : input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeaderWord(input.subject)}`,
    `Date: ${(input.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${input.messageId}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references?.length ? [`References: ${input.references.join(" ")}`] : []),
    `Auto-Submitted: ${input.inReplyTo ? "auto-replied" : "auto-generated"}`,
    "X-Mailer: Muster",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(input.text),
    "",
  ];
  return lines.join("\r\n");
}
