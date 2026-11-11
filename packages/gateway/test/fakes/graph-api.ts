/**
 * Fake WhatsApp Cloud (Graph) API behind an injected fetcher: /messages sends,
 * media lookups (GET /{media-id} → url) and media downloads. Anything else
 * fails the test loudly, so no real network is reached.
 */

export interface GraphCall {
  readonly method: string;
  readonly url: string;
  readonly authorization?: string;
  readonly body?: Record<string, unknown>;
}

export interface FakeGraphApi {
  readonly calls: GraphCall[];
  readonly fetcher: typeof fetch;
  sent(): Array<Record<string, unknown>>;
}

export function createFakeGraphApi(options: {
  readonly version?: string;
  readonly media?: Readonly<Record<string, { readonly bytes: Uint8Array; readonly mime: string }>>;
  /** Other hosts (e.g. a stub model) are passed to the real fetch. */
  readonly passThrough?: (url: string) => boolean;
}): FakeGraphApi {
  const version = options.version ?? "v19.0";
  const calls: GraphCall[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (options.passThrough?.(url)) return fetch(input, init);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ method, url, authorization: headers.get("authorization") ?? undefined, body });
    const graph = `https://graph.facebook.com/${version}/`;
    if (method === "POST" && url.startsWith(graph) && url.endsWith("/messages")) {
      return Response.json({ messaging_product: "whatsapp", messages: [{ id: `wamid.OUT.${calls.length}` }] });
    }
    if (method === "GET" && url.startsWith(graph)) {
      const id = decodeURIComponent(url.slice(graph.length));
      const media = options.media?.[id];
      if (!media) return Response.json({ error: { message: "unknown media" } }, { status: 404 });
      return Response.json({ url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${id}`, mime_type: media.mime, file_size: media.bytes.length, id });
    }
    if (method === "GET" && url.startsWith("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=")) {
      const media = options.media?.[new URL(url).searchParams.get("mid") ?? ""];
      return media ? new Response(media.bytes, { headers: { "content-type": media.mime } }) : new Response("missing", { status: 404 });
    }
    throw new Error(`fake graph: unexpected ${method} ${url}`);
  }) as typeof fetch;
  return {
    calls,
    fetcher,
    sent: () => calls.filter((call) => call.method === "POST" && call.url.endsWith("/messages")).map((call) => call.body ?? {}),
  };
}
