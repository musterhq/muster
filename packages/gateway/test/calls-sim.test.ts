import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readCallLedger } from "@musterhq/core";
import { gatewayConfigPath, startGatewayServer } from "../src/index.js";
import type { CallTurnInput, GatewayConfig } from "../src/index.js";
import { startFakeTwilio } from "./fakes/twilio.js";
import { startStubModel, stubModelConfig } from "./fakes/stub-model.js";

// Spec: MUS-SPEC-25-5A (docs/spec/clauses/25-calls-sms.md#mus-spec-25-5a--a-full-simulated-call-in-ci)
test("a simulated call survives a slow tool and a dropped socket", async () => {
  const twilio = await startFakeTwilio();
  const cwd = await mkdtemp(join(tmpdir(), "muster-calls-sim-"));
  const env = { TWILIO_ACCOUNT_SID_5A: twilio.accountSid, TWILIO_AUTH_TOKEN_5A: twilio.authToken };
  const gateway: GatewayConfig = {
    token: "test-token-5a",
    calls: {
      provider: "twilio",
      accountSidEnv: "TWILIO_ACCOUNT_SID_5A",
      authTokenEnv: "TWILIO_AUTH_TOKEN_5A",
      from: "+15550005000",
      contacts: { owner: "+15550005001", dentist: "+15550005002" },
      ownerName: "Dhairya",
      apiBaseUrl: twilio.baseUrl,
    },
    sms: { enabled: true },
  };
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify(gateway));
  const turns: CallTurnInput[] = [];
  const runner = async (input: CallTurnInput) => {
    turns.push(input);
    if (input.heard === undefined) return { say: "I'm calling to move Dhairya's 3pm appointment. Does Thursday work?" };
    if (input.heard === "Thursday at four works") {
      await delay(3_000); // the slow tool (a calendar write) of this scenario
      return { say: "Booked: Thursday at four.", outcome: "Moved to Thursday 4pm." };
    }
    return { say: "Yes, Thursday at four. Thank you." };
  };
  const llm = await startStubModel("unused");
  const running = await startGatewayServer({ config: stubModelConfig(llm.url), gateway, cwd, env, callApproval: async () => "approve", callTurnRunner: runner }, 0);
  try {
    const placed = await running.calls!.requestCall({ contact: "dentist", brief: "Move my 3pm to Thursday; do not agree to fees" });
    assert.equal(placed.status, "placed");
    // 1 answer · 2 "Thursday at four works" · 3 slow tool · 4 dropped socket, retried · 5 the callee hangs up.
    const play = await twilio.play(twilio.calls[0], [
      { say: "Thursday at four works" },
      { say: "Can you confirm the time?", dropAndRetry: true },
    ], { duration: 31 });
    await running.waitForIdle();

    assert.equal(play.ended, "callee-hung-up");
    assert.deepEqual(play.heard.filter((line) => !/^(One moment|Still on it|Just a moment more)\.$/.test(line)), [
      "Hi, this is an AI assistant calling for Dhairya.",
      "I'm calling to move Dhairya's 3pm appointment. Does Thursday work?",
      "Booked: Thursday at four.",
      "Yes, Thursday at four. Thank you.",
    ]);
    assert.ok(play.heard.includes("One moment."), "the agent says one moment while the tool runs");
    const deadAir = Math.max(...play.webhooks.map((hook) => hook.latencyMs));
    assert.ok(deadAir <= 1_500, `longest silence ${deadAir} ms`);
    assert.equal(turns.length, 3, "the retried request after the drop does not run the turn again");
    assert.ok(play.webhooks.every((hook) => hook.status === 200));

    const records = (await readCallLedger(cwd)).filter((entry) => entry.kind === "call.record");
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.ok(record.kind === "call.record");
    assert.equal(record.id, placed.callId, "the reconnect resumed the same call");
    assert.equal(record.endedBy, "callee");
    const transcript = (await readFile(record.transcriptPath!, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { speaker: string; text: string });
    assert.deepEqual(transcript.map((line) => `${line.speaker}: ${line.text}`), [
      "agent: Hi, this is an AI assistant calling for Dhairya.",
      "agent: I'm calling to move Dhairya's 3pm appointment. Does Thursday work?",
      "callee: Thursday at four works",
      "agent: Booked: Thursday at four.",
      "callee: Can you confirm the time?",
      "agent: Yes, Thursday at four. Thank you.",
    ]);

    // A second completed callback (a provider retry with a new timestamp) writes nothing more.
    assert.equal((await twilio.status(twilio.calls[0], "completed", [["CallDuration", "31"]])).status, 200);
    await running.waitForIdle();
    assert.equal((await readCallLedger(cwd)).filter((entry) => entry.kind === "call.record").length, 1);
  } finally {
    await running.close();
    await llm.close();
    await twilio.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
