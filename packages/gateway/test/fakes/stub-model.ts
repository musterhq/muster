import { createServer } from "node:http";
import { defaultConfig } from "@musterhq/core";
import type { MusterConfig } from "@musterhq/core";

/** OpenAI-compatible model stub that always answers `content`. */
export async function startStubModel(content: string): Promise<{ readonly url: string; readonly prompts: string[]; close(): Promise<void> }> {
  const prompts: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      prompts.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    prompts,
    close: () => new Promise<void>((resolvePromise) => { server.closeAllConnections(); server.close(() => resolvePromise()); }),
  };
}

export function stubModelConfig(baseUrl: string): MusterConfig {
  const config = defaultConfig();
  return {
    ...config,
    providers: {
      ...config.providers,
      stub: { id: "stub", kind: "openai-compatible", baseUrl, defaultModel: "stub-model", timeoutMs: 5000 },
    },
    runtimes: { native: { id: "native", enabled: true, provider: "stub", routes: {} } },
    routing: { ...config.routing, defaultRuntime: "native" },
  };
}
