/**
 * A fake Telegram Bot API behind an injected fetcher: records every method
 * call, serves getFile and the file bytes for known file ids, and accepts
 * sendMessage / sendVoice / sendDocument / sendChatAction.
 */

export interface FakeTelegramCall {
  readonly method: string;
  /** JSON body, or the multipart fields (files as { name, type, size }). */
  readonly body: Record<string, unknown>;
}

export interface FakeTelegramBotApi {
  readonly fetcher: typeof fetch;
  readonly calls: FakeTelegramCall[];
  readonly downloads: string[];
  /** Calls to one method, in order. */
  sent(method: string): FakeTelegramCall[];
}

export function createFakeTelegramBotApi(options: {
  readonly token: string;
  readonly files?: Readonly<Record<string, { readonly path: string; readonly bytes: Uint8Array }>>;
}): FakeTelegramBotApi {
  const calls: FakeTelegramCall[] = [];
  const downloads: string[] = [];
  let messageId = 100;
  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.telegram.org") throw new Error(`fake telegram: unexpected host ${url.origin}`);
    const filePrefix = `/file/bot${options.token}/`;
    if (url.pathname.startsWith(filePrefix)) {
      const path = url.pathname.slice(filePrefix.length);
      downloads.push(path);
      const file = Object.values(options.files ?? {}).find((entry) => entry.path === path);
      return file ? new Response(file.bytes, { status: 200 }) : new Response("Not Found", { status: 404 });
    }
    const prefix = `/bot${options.token}/`;
    if (!url.pathname.startsWith(prefix)) return json({ ok: false, description: "Unauthorized" }, 401);
    const method = url.pathname.slice(prefix.length);
    let body: Record<string, unknown> = {};
    const type = request.headers.get("content-type") ?? "";
    if (type.startsWith("multipart/form-data")) {
      const form = await request.formData();
      for (const [key, value] of form.entries()) {
        body[key] = typeof value === "string" ? value : { name: value.name, type: value.type, size: value.size };
      }
    } else {
      const text = await request.text();
      body = text ? JSON.parse(text) as Record<string, unknown> : {};
    }
    calls.push({ method, body });
    if (method === "getFile") {
      const file = options.files?.[String(body.file_id)];
      return file
        ? json({ ok: true, result: { file_id: body.file_id, file_path: file.path, file_size: file.bytes.length } })
        : json({ ok: false, description: "Bad Request: invalid file_id" }, 400);
    }
    messageId += 1;
    return json({ ok: true, result: { message_id: messageId } });
  }) as typeof fetch;
  return { fetcher, calls, downloads, sent: (method) => calls.filter((call) => call.method === method) };
}
