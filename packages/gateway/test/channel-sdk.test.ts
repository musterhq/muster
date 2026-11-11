import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  approvePairing,
  channelRegistryTable,
  channelWebhookAdapter,
  ChannelVerificationError,
  defaultChannelRegistry,
  initGatewayConfig,
  requestPairing,
  sendToChannel,
  slackEventToSurfaceMessage,
  startGatewayServer,
  telegramUpdateToSurfaceMessage,
} from "../src/index.js";
import type { GatewayConfig } from "../src/index.js";
import { startStubModel, stubModelConfig } from "./fakes/stub-model.js";

interface CapturedCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function captureFetcher(respond: (url: string, index: number) => unknown): { readonly calls: CapturedCall[]; readonly fetcher: typeof fetch } {
  const calls: CapturedCall[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ url, body });
    const payload = respond(url, calls.length);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetcher };
}

// Spec: MUS-SPEC-18-1A
test("the default registry lists telegram, slack, matrix and email with their capabilities", () => {
  const registry = defaultChannelRegistry();
  // Spec 24-1A extends the registry; these four must stay registered.
  for (const id of ["email", "matrix", "slack", "telegram"]) assert.ok(registry.get(id), id);
  const telegram = registry.get("telegram")!;
  const slack = registry.get("slack")!;
  const matrix = registry.get("matrix")!;
  const email = registry.get("email")!;
  assert.equal(telegram.capabilities.buttons, true);
  assert.equal(telegram.capabilities.edit, true);
  assert.equal(telegram.capabilities.maxTextLength, 4096);
  assert.equal(slack.capabilities.buttons, true);
  assert.equal(slack.capabilities.edit, true);
  assert.equal(matrix.capabilities.buttons, false);
  assert.equal(matrix.capabilities.edit, true);
  assert.equal(email.capabilities.buttons, false);
  assert.equal(email.capabilities.edit, false);
  for (const adapter of registry.list()) assert.ok(adapter.capabilities.maxTextLength > 0, adapter.id);
});

// Spec: MUS-SPEC-18-1B
test("telegram and slack SDK adapters verify, key and normalize exactly like the legacy routes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-channel-sdk-parity-"));
  const llm = await startStubModel("ok");
  const init = await initGatewayConfig(cwd);
  const gateway: GatewayConfig = {
    ...init.config,
    telegram: { botToken: "123:abc", secretToken: "tg-secret" },
    slack: { botToken: "xoxb-1", signingSecret: "slack-signing", mode: "http" },
  };
  const { fetcher } = captureFetcher(() => ({ ok: true, result: { message_id: 1 } }));
  const running = await startGatewayServer({ config: stubModelConfig(llm.url), gateway, cwd, fetcher }, 0);
  const registry = defaultChannelRegistry();
  const telegram = registry.get("telegram")!;
  const slack = registry.get("slack")!;
  const update = { update_id: 7, message: { message_id: 11, from: { id: 5 }, chat: { id: 9 }, text: "hello" } };
  const telegramBody = JSON.stringify(update);
  const slackPayload = { type: "event_callback", event_id: "Ev1", team_id: "T1", event: { type: "message", user: "U1", channel: "C1", text: "hi", ts: "171.5" } };
  const slackBody = JSON.stringify(slackPayload);
  try {
    const wrongTelegram = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" },
      body: telegramBody,
    });
    assert.equal(wrongTelegram.status, 401);
    assert.deepEqual(await wrongTelegram.json(), { error: "Telegram secret token mismatch." });
    const badSlack = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-slack-signature": "v0=bad", "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)) },
      body: slackBody,
    });
    assert.equal(badSlack.status, 401);
    assert.deepEqual(await badSlack.json(), { error: "Slack signature verification failed." });
  } finally {
    await running.close();
    await llm.close();
  }

  await assert.rejects(
    async () => telegram.verifyInbound!({ body: telegramBody, headers: { "x-telegram-bot-api-secret-token": "wrong" }, gateway }),
    (error: unknown) => error instanceof ChannelVerificationError && error.status === 401 && error.message === "Telegram secret token mismatch.",
  );
  await telegram.verifyInbound!({ body: telegramBody, headers: { "x-telegram-bot-api-secret-token": "tg-secret" }, gateway });
  assert.equal(telegram.deliveryKey!(telegramBody), "telegram:7");
  assert.deepEqual(telegram.normalize(update, {}), [telegramUpdateToSurfaceMessage(update)]);
  assert.deepEqual(telegram.normalize({ update_id: 8 }, {}), []);

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", "slack-signing").update(`v0:${timestamp}:${slackBody}`).digest("hex")}`;
  await slack.verifyInbound!({ body: slackBody, headers: { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp }, gateway });
  await assert.rejects(
    async () => slack.verifyInbound!({ body: slackBody, headers: { "x-slack-signature": "v0=bad", "x-slack-request-timestamp": timestamp }, gateway }),
    (error: unknown) => error instanceof ChannelVerificationError && error.status === 401 && error.message === "Slack signature verification failed.",
  );
  assert.equal(slack.deliveryKey!(slackBody), "slack:Ev1");
  const legacy = slackEventToSurfaceMessage(slackPayload);
  assert.equal(legacy.kind, "message");
  assert.deepEqual(slack.normalize(slackPayload, {}), [legacy.kind === "message" ? legacy.message : undefined]);
  assert.deepEqual(slack.normalize({ type: "url_verification", challenge: "x" }, {}), []);
});

// Spec: MUS-SPEC-18-2A
test("sendToChannel splits long text into channel-sized messages in order", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-channel-sdk-chunk-"));
  const init = await initGatewayConfig(cwd);
  const gateway: GatewayConfig = { ...init.config, telegram: { botToken: "123:abc" } };
  const { calls, fetcher } = captureFetcher((_url, index) => ({ ok: true, result: { message_id: 100 + index } }));
  const text = Array.from({ length: 1_500 }, (_, index) => `word${index % 10} `).join("");
  assert.ok(text.length >= 9_000);
  const result = await sendToChannel("telegram", "42", text, { gateway, fetcher, cwd });
  const sends = calls.filter((call) => call.url.endsWith("/sendMessage"));
  assert.equal(sends.length, 3);
  for (const call of sends) {
    assert.equal(call.body.chat_id, "42");
    assert.ok(String(call.body.text).length <= 4096);
  }
  assert.equal(sends.map((call) => String(call.body.text)).join(""), text);
  assert.deepEqual(result.messageIds, ["101", "102", "103"]);
  assert.equal(result.channelId, "telegram");
});

// Spec: MUS-SPEC-18-2B
test("sendToChannel posts into a Slack thread and refuses unknown or unconfigured channels", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-channel-sdk-slack-"));
  const init = await initGatewayConfig(cwd);
  const gateway: GatewayConfig = { ...init.config, slack: { botToken: "xoxb-1" } };
  const { calls, fetcher } = captureFetcher(() => ({ ok: true, ts: "171.9" }));
  const result = await sendToChannel("slack", { conversationId: "C1", replyTo: "171.5" }, "done", { gateway, fetcher, cwd });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /chat\.postMessage$/);
  assert.equal(calls[0].body.channel, "C1");
  assert.equal(calls[0].body.thread_ts, "171.5");
  assert.equal(calls[0].body.text, "done");
  assert.deepEqual(result.messageIds, ["171.9"]);
  await assert.rejects(sendToChannel("nope", "x", "hi", { gateway, fetcher, cwd }), /Unknown channel: nope/);
  await assert.rejects(sendToChannel("matrix", "!r:x", "hi", { gateway, fetcher, cwd }), /muster channels setup matrix/);
});

// Spec: MUS-SPEC-24-1A (docs/spec/clauses/24-channels-sdk-2.md#mus-spec-24-1a--the-registry-lists-all-eight-channels-with-honest-capabilities)
test("the registry lists every channel with its real capabilities", async () => {
  const registry = defaultChannelRegistry();
  assert.deepEqual(
    registry.list().map((adapter) => adapter.id).sort(),
    ["discord", "email", "googlechat", "matrix", "slack", "teams", "telegram", "whatsapp", "whatsapp-cloud"],
  );
  const capability = (id: string) => registry.get(id)!.capabilities;
  for (const id of ["discord", "slack", "teams", "googlechat", "whatsapp-cloud"]) assert.equal(capability(id).buttons, true, `${id} declares buttons`);
  assert.equal(capability("whatsapp").buttons, false, "personal WhatsApp uses numbered choices");
  assert.equal(capability("discord").maxTextLength, 2000);
  assert.equal(capability("whatsapp").maxTextLength, 4096);
  assert.equal(capability("whatsapp-cloud").maxTextLength, 4096);
  assert.equal(capability("googlechat").maxTextLength, 4096);
  assert.equal(capability("teams").maxTextLength, 28000);
  const numbered = registry.get("whatsapp")!.renderApproval({
    request: { runId: "r1", gateId: "g1", show: "deploy", options: ["approve", "reject"] },
    actions: { approve: "a", reject: "b" },
  });
  assert.equal(numbered.buttons, undefined);
  assert.match(numbered.text, /Reply 1 to approve or 2 to reject\.$/);

  const cwd = await mkdtemp(join(tmpdir(), "muster-channel-sdk-table-"));
  const init = await initGatewayConfig(cwd);
  const gateway: GatewayConfig = {
    ...init.config,
    discord: { botTokenEnv: "DISCORD_BOT_TOKEN" },
    teams: { appId: "app-1", appPasswordEnv: "TEAMS_APP_PASSWORD" },
  };
  const table = channelRegistryTable(registry, gateway);
  const lines = table.trimEnd().split("\n");
  assert.match(lines[0], /^channel\tlabel\tbuttons\tedit\tmax_text\tstatus$/);
  assert.equal(lines.length, 10);
  assert.match(table, /^discord\tDiscord\tyes\tyes\t2000\tconfigured$/m);
  assert.match(table, /^teams\tMicrosoft Teams\tyes\tno\t28000\tconfigured$/m);
  assert.match(table, /^whatsapp\tWhatsApp \(linked device\)\tno\tno\t4096\tnot configured$/m);
  assert.match(table, /^googlechat\tGoogle Chat\tyes\tno\t4096\tnot configured$/m);
});

// Spec: MUS-SPEC-24-6A (docs/spec/clauses/24-channels-sdk-2.md#mus-spec-24-6a--the-legacy-handlers-are-gone-and-every-old-route-still-answers)
test("old adapter routes are served by the sdk runner with unchanged responses", async () => {
  const source = await readFile(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
  for (const legacy of ["handleDiscordWebhook", "handleWhatsAppWebhook", "handleTeamsWebhook", "handleGchatWebhook"]) {
    assert.equal(source.includes(legacy), false, `${legacy} is gone from server.ts`);
  }
  for (const [route, channel] of [["discord", "discord"], ["whatsapp-cloud", "whatsapp-cloud"], ["teams", "teams"], ["gchat", "googlechat"], ["googlechat", "googlechat"]]) {
    assert.equal(channelWebhookAdapter(route)?.id, channel, `/v1/adapters/${route} is served by the ${channel} SDK adapter`);
  }

  const cwd = await mkdtemp(join(tmpdir(), "muster-channel-sdk-routes-"));
  const llm = await startStubModel("routed by the sdk");
  const init = await initGatewayConfig(cwd);
  const teamsSecret = Buffer.from("teams-secret-6a").toString("base64");
  const gateway: GatewayConfig = {
    ...init.config,
    discord: { botToken: "discord-6a" },
    "whatsapp-cloud": { accessToken: "EAAG-6a", verifyToken: "verify-6a", phoneNumberId: "6600000001" },
    gchat: { verificationToken: "gchat-6a" },
    teams: { hmacSecret: teamsSecret },
  };
  const { calls, fetcher } = captureFetcher(() => ({ messages: [{ id: "wamid.6A-OUT" }] }));
  const running = await startGatewayServer({ config: stubModelConfig(llm.url), gateway, cwd, fetcher }, 0);
  const pairs: Array<[string, string]> = [
    ["discord:6600", "6601"],
    ["whatsapp-cloud:6600000001", "15556600001"],
    ["gchat:app", "users/6a-1"],
    ["teams:tenant-6a", "29:6a-user"],
  ];
  for (const [surface, sender] of pairs) await requestPairing(surface, sender, cwd).then((pending) => approvePairing(pending.code, cwd));
  const post = (route: string, body: string, headers: Record<string, string> = { authorization: "Bearer test-token-unused" }) =>
    fetch(`http://127.0.0.1:${running.port}/v1/adapters/${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const bearer = { authorization: `Bearer ${gateway.token}` };
  try {
    const ping = await post("discord", JSON.stringify({ id: "6a-ping", type: 1 }), bearer);
    assert.equal(ping.status, 200);
    assert.deepEqual(await ping.json(), { type: 1 });
    const command = await post("discord", JSON.stringify({
      id: "6a-command-1", type: 2, guild_id: "6600", channel_id: "6a-channel",
      member: { user: { id: "6601" } }, data: { name: "muster", options: [{ name: "prompt", type: 3, value: "status?" }] },
    }), bearer);
    assert.equal(command.status, 200);
    assert.deepEqual(await command.json(), { type: 4, data: { content: "routed by the sdk" } });
    const unknownDiscord = await post("discord", JSON.stringify({ id: "6a-component", type: 3, channel_id: "c", member: { user: { id: "6601" } }, data: { custom_id: "nothing" } }), bearer);
    assert.equal(unknownDiscord.status, 200);
    assert.equal((await unknownDiscord.json() as { ok: boolean }).ok, true);

    const whatsapp = await post("whatsapp-cloud", JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "6600000001" }, messages: [{ from: "15556600001", id: "wamid.6A-1", type: "text", text: { body: "hi" } }] } }] }],
    }), bearer);
    assert.equal(whatsapp.status, 200);
    assert.deepEqual(await whatsapp.json(), { ok: true, accepted: true });
    await running.waitForIdle();
    assert.equal(calls.filter((call) => call.url === "https://graph.facebook.com/v19.0/6600000001/messages").length, 1);

    for (const [index, route] of ["gchat", "googlechat"].entries()) {
      const event = {
        type: "MESSAGE", token: "gchat-6a", space: { name: "spaces/SIXA" },
        message: { name: `spaces/SIXA/messages/6a-${index}`, sender: { name: "users/6a-1", type: "HUMAN" }, text: "hi", thread: { name: "spaces/SIXA/threads/T6A" } },
        user: { name: "users/6a-1", type: "HUMAN" },
      };
      const reply = await post(route, JSON.stringify(event), {});
      assert.equal(reply.status, 200, route);
      assert.deepEqual(await reply.json(), { text: "routed by the sdk", thread: { name: "spaces/SIXA/threads/T6A" } });
      assert.equal((await post(route, JSON.stringify({ ...event, token: "forged" }), {})).status, 401);
    }

    const activity = JSON.stringify({
      type: "message", id: "6a-activity-1", from: { id: "29:6a-user" }, conversation: { id: "19:6a@thread.skype" },
      text: "<at>Muster</at> hi", channelData: { tenant: { id: "tenant-6a" } },
    });
    const teams = await post("teams", activity, { authorization: `HMAC ${createHmac("sha256", Buffer.from(teamsSecret, "base64")).update(activity, "utf8").digest("base64")}` });
    assert.equal(teams.status, 200);
    assert.deepEqual(await teams.json(), { type: "message", text: "routed by the sdk" });
    const unsigned = await post("teams", activity, {});
    assert.equal(unsigned.status, 401);
    assert.deepEqual(await unsigned.json(), { error: "Teams HMAC signature mismatch." });
  } finally {
    await running.close();
    await llm.close();
  }
});
