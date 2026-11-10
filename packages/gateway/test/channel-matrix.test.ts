import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getFlowRun, runFlow } from "@musterhq/core";
import type { FlowToolRegistry } from "@musterhq/core";
import {
  approvePairing,
  channelCursorPath,
  initGatewayConfig,
  loadPairings,
  requestPairing,
  runChannelWorker,
  sendToChannel,
} from "../src/index.js";
import type { GatewayConfig } from "../src/index.js";
import { startFakeMatrixHomeserver } from "./fakes/matrix-homeserver.js";
import type { FakeMatrixHomeserver } from "./fakes/matrix-homeserver.js";
import { startStubModel, stubModelConfig } from "./fakes/stub-model.js";

const ROOM = "!room:fake.test";
const ALICE = "@alice:fake.test";
const MALLORY = "@mallory:fake.test";
const SURFACE = "matrix:@muster:fake.test";
const ENV = { MATRIX_TOKEN: "fake-matrix-token" };

async function setup(prefix: string): Promise<{
  readonly cwd: string;
  readonly gateway: GatewayConfig;
  readonly matrix: FakeMatrixHomeserver;
  readonly llm: Awaited<ReturnType<typeof startStubModel>>;
}> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const init = await initGatewayConfig(cwd);
  const matrix = await startFakeMatrixHomeserver();
  const llm = await startStubModel("hello from muster");
  const gateway: GatewayConfig = {
    ...init.config,
    channels: {
      matrix: {
        homeserverUrl: matrix.url,
        userId: matrix.botUserId,
        accessTokenEnv: "MATRIX_TOKEN",
        allowFrom: [ALICE],
        syncTimeoutMs: 100,
      },
    },
  };
  return { cwd, gateway, matrix, llm };
}

function startWorker(input: { cwd: string; gateway: GatewayConfig; llmUrl: string; registry?: FlowToolRegistry }): { readonly stop: () => Promise<void> } {
  const controller = new AbortController();
  const done = runChannelWorker({
    channelId: "matrix",
    config: stubModelConfig(input.llmUrl),
    gateway: input.gateway,
    cwd: input.cwd,
    env: ENV,
    registry: input.registry,
    signal: controller.signal,
    log: () => undefined,
  });
  return {
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

function bodyOf(event: { content: Record<string, unknown> }): string {
  return String(event.content.body ?? "");
}

async function pair(cwd: string, senderId: string): Promise<void> {
  const pending = await requestPairing(SURFACE, senderId, cwd);
  await approvePairing(pending.code, cwd);
}

// Spec: MUS-SPEC-18-3A
test("matrix: an allowed sender is paired, then answered in the same room as a reply", async () => {
  const { cwd, gateway, matrix, llm } = await setup("muster-matrix-pair-");
  matrix.inject(ROOM, ALICE, "old history that must not be answered");
  const worker = startWorker({ cwd, gateway, llmUrl: llm.url });
  try {
    await matrix.waitForSyncs(2);
    const hi = matrix.inject(ROOM, ALICE, "hi");
    await matrix.waitFor(() => matrix.sent.length === 1);
    const challenge = matrix.sent[0];
    assert.equal(challenge.room_id, ROOM);
    const code = /muster pairing approve ([A-Z2-9]{8})/.exec(bodyOf(challenge))?.[1];
    assert.ok(code, bodyOf(challenge));
    assert.deepEqual((challenge.content["m.relates_to"] as Record<string, unknown>)["m.in_reply_to"], { event_id: hi });
    await approvePairing(code, cwd);

    const question = matrix.inject(ROOM, ALICE, "what's up");
    await matrix.waitFor(() => matrix.sent.length === 2);
    const answer = matrix.sent[1];
    assert.equal(bodyOf(answer), "hello from muster");
    assert.equal(answer.room_id, ROOM);
    assert.deepEqual((answer.content["m.relates_to"] as Record<string, unknown>)["m.in_reply_to"], { event_id: question });

    // The bot's own events come back through /sync and must never be answered.
    await matrix.waitForSyncs(3);
    assert.equal(matrix.sent.length, 2);
    assert.ok(matrix.sent.every((event) => !bodyOf(event).includes("old history")));
    assert.ok(matrix.requests.every((request) => !request.path.includes(ENV.MATRIX_TOKEN)));
    assert.ok(matrix.requests.every((request) => request.authorization === `Bearer ${ENV.MATRIX_TOKEN}`));
  } finally {
    await worker.stop();
    await matrix.close();
    await llm.close();
  }
});

// Spec: MUS-SPEC-18-3B
test("matrix: senders and invites outside the allowlist are ignored", async () => {
  const { cwd, gateway, matrix, llm } = await setup("muster-matrix-allow-");
  await pair(cwd, ALICE);
  const worker = startWorker({ cwd, gateway, llmUrl: llm.url });
  try {
    await matrix.waitForSyncs(2);
    matrix.inject(ROOM, MALLORY, "let me in");
    matrix.invite("!b:fake.test", MALLORY);
    matrix.invite("!c:fake.test", ALICE);
    const sentinel = matrix.inject(ROOM, ALICE, "sentinel");
    await matrix.waitFor(() => matrix.sent.length >= 1);
    await matrix.waitFor(() => matrix.joins.includes("!c:fake.test"));
    assert.equal(matrix.sent.length, 1);
    assert.deepEqual((matrix.sent[0].content["m.relates_to"] as Record<string, unknown>)["m.in_reply_to"], { event_id: sentinel });
    assert.deepEqual(matrix.joins, ["!c:fake.test"]);
    const pairings = await loadPairings(cwd);
    assert.ok(!pairings.pending.some((entry) => entry.senderId === MALLORY));
    assert.ok(!pairings.paired.some((entry) => entry.senderId === MALLORY));
  } finally {
    await worker.stop();
    await matrix.close();
    await llm.close();
  }
});

// Spec: MUS-SPEC-18-3C
test("matrix: a redelivered event after a restart is answered once", async () => {
  const { cwd, gateway, matrix, llm } = await setup("muster-matrix-replay-");
  await pair(cwd, ALICE);
  let worker = startWorker({ cwd, gateway, llmUrl: llm.url });
  try {
    await matrix.waitForSyncs(2);
    const cursorBefore = await readFile(channelCursorPath(cwd, "matrix"), "utf8");
    const event = matrix.inject(ROOM, ALICE, "only once please");
    await matrix.waitFor(() => matrix.sent.length === 1);
    await worker.stop();
    // Simulate a crash after answering but before the cursor was saved.
    await writeFile(channelCursorPath(cwd, "matrix"), cursorBefore, "utf8");
    worker = startWorker({ cwd, gateway, llmUrl: llm.url });
    await matrix.waitForSyncs(3);
    const replies = matrix.sent.filter((sent) => {
      const relates = sent.content["m.relates_to"] as { "m.in_reply_to"?: { event_id?: string } } | undefined;
      return relates?.["m.in_reply_to"]?.event_id === event;
    });
    assert.equal(replies.length, 1);
  } finally {
    await worker.stop();
    await matrix.close();
    await llm.close();
  }
});

// Spec: MUS-SPEC-18-3D
test("matrix: a numbered reply approves a gated flow run once", async () => {
  const { cwd, gateway, matrix, llm } = await setup("muster-matrix-approve-");
  await pair(cwd, ALICE);
  let applied = 0;
  const registry: FlowToolRegistry = {
    echo: async (args) => args,
    apply: async () => { applied += 1; return { applied: true }; },
  };
  const pending = await runFlow({
    id: "matrix-gate",
    steps: [
      { id: "prepare", kind: "tool", tool: "echo", args: { result: "deploy v2" } },
      { id: "authorize", kind: "gate", show: "prepare.result" },
      { id: "apply", kind: "tool", tool: "apply", args: {} },
    ],
  }, { config: stubModelConfig(llm.url), registry, cwd });
  assert.equal(pending.status, "awaiting_approval");
  const worker = startWorker({ cwd, gateway, llmUrl: llm.url, registry });
  try {
    await matrix.waitForSyncs(2);
    await sendToChannel("matrix", { conversationId: ROOM, senderId: ALICE }, {
      text: "Review this deploy",
      approvalRequest: { runId: pending.runId, gateId: pending.gateId!, show: pending.show, options: ["approve", "reject"] },
    }, { gateway, cwd, env: ENV });
    assert.equal(matrix.sent.length, 1);
    assert.match(bodyOf(matrix.sent[0]), /deploy v2/);
    assert.match(bodyOf(matrix.sent[0]), /Reply 1 to approve or 2 to reject\.$/);

    matrix.inject(ROOM, ALICE, "1");
    await matrix.waitFor(() => matrix.sent.length === 2);
    await matrix.waitFor(() => applied === 1);
    assert.equal((await getFlowRun(pending.runId, cwd)).status, "completed");

    matrix.inject(ROOM, ALICE, "1");
    await matrix.waitFor(() => matrix.sent.length === 3);
    assert.equal(applied, 1);
  } finally {
    await worker.stop();
    await matrix.close();
    await llm.close();
  }
});
