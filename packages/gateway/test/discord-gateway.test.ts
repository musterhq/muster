import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getFlowRun, runFlow } from "@musterhq/core";
import type { FlowToolRegistry } from "@musterhq/core";
import {
  approvePairing,
  initGatewayConfig,
  requestPairing,
  runDiscordGateway,
  sendToChannel,
} from "../src/index.js";
import type { GatewayConfig } from "../src/index.js";
import { startFakeDiscord } from "./fakes/discord.js";
import type { FakeDiscord } from "./fakes/discord.js";
import { startStubModel, stubModelConfig } from "./fakes/stub-model.js";

const BOT = "240000000000000001";
const USER_U = "240000000000000002";
const USER_V = "240000000000000003";
const GUILD = "240000000000000010";
const GUILD_CHANNEL = "240000000000000020";
const DM_CHANNEL = "240000000000000030";
const TOKEN = "discord-bot-token-24";
const ENV = { DISCORD_BOT_TOKEN_24: TOKEN };
// GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

function author(id: string, bot = false) {
  return { id, username: id === BOT ? "muster" : `user-${id.slice(-2)}`, bot };
}

function dm(id: string, content: string) {
  return { id, channel_id: DM_CHANNEL, author: author(USER_U), content, mentions: [], type: 0 };
}

function guildMessage(id: string, content: string, mentions: string[] = [], from = USER_U) {
  return { id, channel_id: GUILD_CHANNEL, guild_id: GUILD, author: author(from, from === BOT), content, mentions: mentions.map((mention) => author(mention, mention === BOT)), type: 0 };
}

async function setup(prefix: string, answer: string) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const init = await initGatewayConfig(cwd);
  const discord = await startFakeDiscord({ botUserId: BOT, token: TOKEN, heartbeatIntervalMs: 40 });
  const llm = await startStubModel(answer);
  const gateway: GatewayConfig = {
    ...init.config,
    discord: { botTokenEnv: "DISCORD_BOT_TOKEN_24", apiBaseUrl: discord.apiBaseUrl, gatewayUrl: discord.gatewayUrl },
  };
  for (const surface of ["discord:dm", `discord:${GUILD}`]) {
    await requestPairing(surface, USER_U, cwd).then((pending) => approvePairing(pending.code, cwd));
  }
  return { cwd, gateway, discord, llm };
}

function startWorker(input: { cwd: string; gateway: GatewayConfig; llmUrl: string; registry?: FlowToolRegistry }) {
  const controller = new AbortController();
  const done = runDiscordGateway({
    config: stubModelConfig(input.llmUrl),
    gateway: input.gateway,
    cwd: input.cwd,
    env: ENV,
    registry: input.registry,
    signal: controller.signal,
    reconnect: { initialMs: 10, maxMs: 50 },
    log: () => undefined,
  });
  return { stop: async () => { controller.abort(); await done; } };
}

const opFrames = (discord: FakeDiscord, op: number) => discord.frames.filter((frame) => frame.op === op);

// Spec: MUS-SPEC-24-2A (docs/spec/clauses/24-channels-sdk-2.md#mus-spec-24-2a--discord-dms-and-mentions-over-the-gateway-websocket)
test("discord DMs and mentions start turns over the gateway, others are ignored, and resume never double-answers", async () => {
  const long = Array.from({ length: 520 }, (_, index) => `word${index % 10}`).join(" ");
  assert.ok(long.length > 2000 && long.length <= 4000);
  const { cwd, gateway, discord, llm } = await setup("muster-discord-gw-", long);
  const worker = startWorker({ cwd, gateway, llmUrl: llm.url });
  try {
    // IDENTIFY with the message intents, then heartbeats at the HELLO interval, each acknowledged.
    await discord.waitFor(() => opFrames(discord, 2).length === 1, "IDENTIFY");
    const identify = opFrames(discord, 2)[0].d;
    assert.equal(identify.token, TOKEN);
    assert.equal(identify.intents, INTENTS);
    await discord.waitFor(() => opFrames(discord, 1).length >= 3, "heartbeats");
    const beats = opFrames(discord, 1).map((frame) => frame.at);
    assert.ok(beats[2] - beats[1] >= 20, "heartbeats follow the HELLO interval, not a busy loop");

    // A DM and a mention each start one turn; replies reference the inbound message and split at 2000.
    discord.dispatch("MESSAGE_CREATE", dm("2401", "what is 2+2"));
    discord.dispatch("MESSAGE_CREATE", guildMessage("2402", `<@${BOT}> summarize the deploy`, [BOT]));
    discord.dispatch("MESSAGE_CREATE", guildMessage("2403", "talking among ourselves"));
    discord.dispatch("MESSAGE_CREATE", guildMessage("2404", `<@${BOT}> echo`, [BOT], BOT));
    discord.dispatch("MESSAGE_CREATE", dm("2405", "and 3+3?"));
    await discord.waitFor(() => discord.sentMessages(DM_CHANNEL).length === 4, "two split DM replies");
    assert.equal(llm.prompts.length, 3, "the un-mentioned guild message and the bot's own message start no turn");
    assert.match(llm.prompts[1], /summarize the deploy/);
    assert.doesNotMatch(llm.prompts[1], new RegExp(`<@${BOT}>`));

    const dmReplies = discord.sentMessages(DM_CHANNEL);
    const guildReplies = discord.sentMessages(GUILD_CHANNEL);
    assert.equal(guildReplies.length, 2);
    for (const replies of [dmReplies.slice(0, 2), guildReplies]) {
      assert.ok(replies.every((call) => call.authorization === `Bot ${TOKEN}`));
      assert.ok(replies.every((call) => call.body.content.length <= 2000));
      assert.equal(replies.map((call) => call.body.content).join(""), long);
      assert.equal(replies[1].body.message_reference, undefined, "only the first chunk is a reply");
    }
    assert.equal(dmReplies[0].body.message_reference.message_id, "2401");
    assert.equal(guildReplies[0].body.message_reference.message_id, "2402");

    // Dropped socket: RESUME with session id and sequence; a replayed message is not answered again.
    const lastSeq = discord.dispatch("TYPING_START", { channel_id: DM_CHANNEL });
    discord.onResume("accept", [{ type: "MESSAGE_CREATE", data: dm("2401", "what is 2+2") }, { type: "MESSAGE_CREATE", data: dm("2406", "still there?") }]);
    await discord.waitFor(() => discord.frames.some((frame) => frame.op === 1 && frame.d === lastSeq), "heartbeat carrying the last sequence");
    discord.drop();
    await discord.waitFor(() => opFrames(discord, 6).length === 1, "RESUME");
    assert.deepEqual(opFrames(discord, 6)[0].d, { token: TOKEN, session_id: "session-1", seq: lastSeq });
    assert.equal(opFrames(discord, 2).length, 1, "a resumable session is not re-identified");
    await discord.waitFor(() => discord.sentMessages(DM_CHANNEL).length === 6, "reply to the message after resume");
    assert.equal(llm.prompts.length, 4, "the replayed 2401 was not run again");
    assert.equal(discord.sentMessages().filter((call) => call.body.message_reference?.message_id === "2401").length, 1);

    // A rejected resume re-identifies.
    discord.onResume("reject");
    discord.drop();
    await discord.waitFor(() => opFrames(discord, 2).length === 2, "re-IDENTIFY after INVALID_SESSION");
    assert.equal(opFrames(discord, 6).length, 2);
    assert.ok(opFrames(discord, 6)[1].at <= opFrames(discord, 2)[1].at, "resume was tried first");
    discord.dispatch("MESSAGE_CREATE", dm("2407", "new session"));
    await discord.waitFor(() => discord.sentMessages(DM_CHANNEL).length === 8, "reply in the new session");
    assert.equal(llm.prompts.length, 5);
  } finally {
    await worker.stop();
    await discord.close();
    await llm.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-24-2B (docs/spec/clauses/24-channels-sdk-2.md#mus-spec-24-2b--discord-approvals-use-buttons-and-only-the-requester-can-press-them)
test("discord approval buttons resolve only for the requester", async () => {
  const { cwd, gateway, discord, llm } = await setup("muster-discord-approve-", "ok");
  let applied = 0;
  const registry: FlowToolRegistry = {
    echo: async (args) => args,
    apply: async () => { applied += 1; return { applied: true }; },
  };
  const pending = await runFlow({
    id: "discord-gate",
    steps: [
      { id: "prepare", kind: "tool", tool: "echo", args: { result: "deploy v24" } },
      { id: "authorize", kind: "gate", show: "prepare.result" },
      { id: "apply", kind: "tool", tool: "apply", args: {} },
    ],
  }, { config: stubModelConfig(llm.url), registry, cwd });
  assert.equal(pending.status, "awaiting_approval");
  const worker = startWorker({ cwd, gateway, llmUrl: llm.url, registry });
  try {
    await discord.waitFor(() => opFrames(discord, 2).length === 1, "IDENTIFY");
    await sendToChannel("discord", { conversationId: GUILD_CHANNEL, senderId: USER_U, surfaceId: `discord:${GUILD}` }, {
      text: "Review this deploy",
      approvalRequest: { runId: pending.runId, gateId: pending.gateId!, show: pending.show, options: ["approve", "reject"] },
    }, { gateway, cwd, env: ENV });
    const prompt = discord.sentMessages(GUILD_CHANNEL)[0];
    assert.match(prompt.body.content, /deploy v24/);
    const buttons = prompt.body.components[0].components as Array<{ label: string; custom_id: string; style: number }>;
    assert.deepEqual(buttons.map((button) => button.label), ["Approve", "Deny"]);

    const press = (id: string, user: string, customId: string) => discord.dispatch("INTERACTION_CREATE", {
      id, token: `token-${id}`, type: 3, application_id: "app-24", guild_id: GUILD, channel_id: GUILD_CHANNEL,
      member: { user: author(user) }, message: { id: "out-1", channel_id: GUILD_CHANNEL }, data: { custom_id: customId, component_type: 2 },
    });
    const callback = (id: string) => discord.rest.find((call) => call.path === `/interactions/${id}/token-${id}/callback`);

    press("2451", USER_V, buttons[0].custom_id);
    await discord.waitFor(() => callback("2451") !== undefined, "callback for V");
    assert.equal(callback("2451")!.body.type, 4);
    assert.equal(callback("2451")!.body.data.flags, 64, "ephemeral: only V sees it");
    assert.match(callback("2451")!.body.data.content, /only the person who asked can approve this/i);
    assert.equal((await getFlowRun(pending.runId, cwd)).status, "awaiting_approval");
    assert.equal(applied, 0);

    press("2452", USER_U, buttons[0].custom_id);
    await discord.waitFor(() => callback("2452") !== undefined && applied === 1, "U's approval");
    assert.equal(callback("2452")!.body.type, 7, "the approval message is edited in place");
    assert.match(callback("2452")!.body.data.content, /approv/i);
    assert.deepEqual(callback("2452")!.body.data.components, []);
    assert.equal((await getFlowRun(pending.runId, cwd)).status, "completed");
  } finally {
    await worker.stop();
    await discord.close();
    await llm.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
