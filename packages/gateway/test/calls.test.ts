import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createToolRegistry, formatCallRecordsTable, readCallLedger, registerBuiltinTools } from "@musterhq/core";
import type { CallApprovalCard, CallsConfig } from "@musterhq/core";
import { approvePairing, CallManager, gatewayConfigPath, requestPairing, startGatewayServer, twilioSignature } from "../src/index.js";
import type { CallTurnInput, CallTurnResult, GatewayConfig } from "../src/index.js";
import { postSigned, startFakeTwilio } from "./fakes/twilio.js";
import type { FakeTwilio } from "./fakes/twilio.js";
import { startStubModel, stubModelConfig } from "./fakes/stub-model.js";

const FROM = "+15550001111";
const OWNER = "+15551234567";
const DENTIST = "+15557654321";
const BRIEF = "Move my 3pm to Thursday; do not agree to fees";

async function workspace(name: string, twilio: FakeTwilio, calls: Partial<CallsConfig> = {}): Promise<{ cwd: string; gateway: GatewayConfig; env: Record<string, string> }> {
  const cwd = await mkdtemp(join(tmpdir(), `muster-calls-${name}-`));
  const gateway: GatewayConfig = {
    token: "test-token-25",
    calls: {
      provider: "twilio",
      accountSidEnv: "TWILIO_ACCOUNT_SID_25",
      authTokenEnv: "TWILIO_AUTH_TOKEN_25",
      from: FROM,
      contacts: { owner: OWNER, dentist: DENTIST },
      ownerName: "Dhairya",
      maxMinutes: 5,
      maxUsdPerCall: 0.5,
      autoApproveOwner: false,
      apiBaseUrl: twilio.baseUrl,
      ...calls,
    },
    sms: { enabled: true },
  };
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify(gateway));
  return { cwd, gateway, env: { TWILIO_ACCOUNT_SID_25: twilio.accountSid, TWILIO_AUTH_TOKEN_25: twilio.authToken } };
}

function scriptedTurns(answer: (input: CallTurnInput) => CallTurnResult | Promise<CallTurnResult>) {
  const inputs: CallTurnInput[] = [];
  return {
    inputs,
    runner: async (input: CallTurnInput) => {
      inputs.push(input);
      return answer(input);
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

// Spec: MUS-SPEC-25-1A (docs/spec/clauses/25-calls-sms.md#mus-spec-25-1a--call_contact-needs-a-known-contact-and-an-approved-brief)
test("call_contact dials only named contacts after approval", async () => {
  const twilio = await startFakeTwilio();
  const { cwd, gateway, env } = await workspace("1a", twilio);
  const cards: CallApprovalCard[] = [];
  let decide!: (answer: "approve" | "deny") => void;
  const manager = new CallManager({
    cwd,
    gateway,
    env,
    publicUrl: () => "https://muster.example.test",
    approve: (card) => {
      cards.push(card);
      return new Promise((resolvePromise) => { decide = resolvePromise; });
    },
    turnRunner: async () => ({ say: "unused" }),
    notifyOwner: async () => undefined,
  });
  const registry = createToolRegistry();
  registerBuiltinTools(registry);
  const ctx = { cwd, calls: manager };
  try {
    const pending = registry.execute("call_contact", { contact: "dentist", brief: BRIEF }, ctx);
    await waitFor(() => cards.length === 1);
    assert.deepEqual(cards[0].text.split("\n"), [
      "☎ Call dentist (+1 555-765-4321)?",
      `Brief: ${BRIEF}`,
      "Cap: 5 min · $0.50",
      "If no answer: tell you",
      "y call · n cancel",
    ]);
    assert.equal(twilio.calls.length, 0, "nothing is dialled before y");
    decide("approve");
    const placed = await pending;
    assert.equal(placed.ok, true, JSON.stringify(placed));
    assert.equal(twilio.calls.length, 1);
    const call = twilio.calls[0];
    assert.equal(call.to, DENTIST);
    assert.equal(call.form.find(([key]) => key === "From")?.[1], FROM);
    assert.match(call.statusCallback, /^https:\/\/muster\.example\.test\/v1\/calls\/twilio\/status\?call=call_[0-9a-f]+$/);
    assert.match(call.url, /^https:\/\/muster\.example\.test\/v1\/calls\/twilio\/voice\?call=call_/);
    assert.ok(Number(call.form.find(([key]) => key === "TimeLimit")?.[1]) <= 5 * 60 + 15, "the provider has its own hard stop");

    for (const contact of ["+15559999999", "unknown", DENTIST]) {
      const refused = await registry.execute("call_contact", { contact, brief: BRIEF }, ctx);
      assert.equal(refused.ok, false);
      assert.match(refused.ok ? "" : refused.error, /call_contact takes a contact name from calls\.contacts/);
    }
    assert.equal(cards.length, 1, "refusals show no card");
    assert.equal(twilio.calls.length, 1, "refusals dial nothing");
    const ledger = await readCallLedger(cwd);
    const refusals = ledger.filter((entry) => entry.kind === "call.refused");
    assert.deepEqual(refusals.map((entry) => entry.kind === "call.refused" && entry.requested), ["+15559999999", "unknown", DENTIST]);
    assert.ok(ledger.some((entry) => entry.kind === "call.placed" && entry.contact === "dentist" && entry.approvedBy === "owner"));
  } finally {
    await manager.close();
    await twilio.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-25-1B (docs/spec/clauses/25-calls-sms.md#mus-spec-25-1b--approvals-during-a-call-fail-closed)
test("approvals during a call are declined and routed to the text channel", async () => {
  const twilio = await startFakeTwilio();
  const { cwd, gateway, env } = await workspace("1b", twilio);
  await requestPairing(`sms:${FROM}`, OWNER, cwd).then((pending) => approvePairing(pending.code, cwd));
  const llm = await startStubModel("model should not run");
  const turns = scriptedTurns((input) => {
    if (input.heard === "Can you also update the notes?") return { say: "Let me note that.", approvalRequest: { title: "edit notes.md" } };
    if (input.heard === undefined) return { say: "I'm calling to move an appointment." };
    return { say: "Understood." };
  });
  const running = await startGatewayServer({ config: stubModelConfig(llm.url), gateway, cwd, env, callApproval: async () => "approve", callTurnRunner: turns.runner }, 0);
  const base = `http://127.0.0.1:${running.port}`;
  try {
    const placed = await running.calls!.requestCall({ contact: "dentist", brief: BRIEF });
    assert.equal(placed.status, "placed");
    const call = twilio.calls[0];
    const params: Array<[string, string]> = [["AccountSid", twilio.accountSid], ["CallSid", call.sid], ["CallStatus", "in-progress"]];
    assert.equal((await postSigned(call.url, params, twilio.authToken)).status, 200);
    const gather1 = await postSigned(`${base}/v1/calls/twilio/gather?call=${placed.callId}&turn=1`, [...params, ["SpeechResult", "Can you also update the notes?"]], twilio.authToken);
    assert.equal(gather1.status, 200);
    assert.match(gather1.body, /Let me note that\./);
    await running.waitForIdle();
    const notice = twilio.messages().find((message) => message.body.startsWith("During the call"));
    assert.ok(notice, JSON.stringify(twilio.messages()));
    assert.equal(notice.to, OWNER);
    assert.match(notice.body, /^During the call with dentist the agent asked to edit notes\.md; approve it here after the call/);

    // The owner texts during the call: a steer for the call, not a second reply.
    const inbound = await postSigned(`${base}/v1/calls/twilio/sms`, [["AccountSid", twilio.accountSid], ["MessageSid", "SM25-1B-STEER"], ["From", OWNER], ["To", FROM], ["Body", "Tell them Friday also works"], ["NumMedia", "0"]], twilio.authToken);
    assert.equal(inbound.status, 200);
    await running.waitForIdle();
    assert.equal(llm.prompts.length, 0, "no model turn for the steer");
    assert.equal(twilio.messages().at(-1)?.body, "Passed to the call with dentist.");
    const gather2 = await postSigned(`${base}/v1/calls/twilio/gather?call=${placed.callId}&turn=2`, [...params, ["SpeechResult", "What else?"]], twilio.authToken);
    assert.equal(gather2.status, 200);
    const next = turns.inputs.at(-1)!;
    assert.deepEqual(next.steers, ["Tell them Friday also works"]);
    assert.ok(next.notices.some((line) => /^Declined: edit notes\.md\./.test(line)), next.notices.join("\n"));
    assert.ok(running.calls!.transcript(placed.callId!).some((line) => line.speaker === "owner" && line.text === "Tell them Friday also works"));
  } finally {
    await running.close();
    await llm.close();
    await twilio.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-25-2A (docs/spec/clauses/25-calls-sms.md#mus-spec-25-2a--the-first-sentence-discloses-the-ai-and-the-cap-ends-the-call)
test("the call opens with an AI disclosure and ends at the time or spend cap", async () => {
  // Time cap, shortened to 2 s.
  const twilio = await startFakeTwilio();
  const timed = await workspace("2a-time", twilio, { maxMinutes: 2 / 60 });
  const llm = await startStubModel("unused");
  const turns = scriptedTurns(() => ({ say: "I'm calling to move an appointment.", usd: 0.001 }));
  let running = await startGatewayServer({ config: stubModelConfig(llm.url), gateway: timed.gateway, cwd: timed.cwd, env: timed.env, callApproval: async () => "approve", callTurnRunner: turns.runner }, 0);
  try {
    const placed = await running.calls!.requestCall({ contact: "dentist", brief: BRIEF });
    const started = Date.now();
    const play = await twilio.play(twilio.calls[0], [{ say: "Hello?" }, { hold: true }], { duration: 2 });
    assert.match(play.heard[0], /^Hi, this is an AI assistant calling for Dhairya/);
    assert.match(play.webhooks[0].body, /^<\?xml[^>]*><Response><Say>Hi, this is an AI assistant calling for Dhairya\.<\/Say>/, "the disclosure is the first verb");
    assert.equal(play.ended, "api");
    assert.ok(Date.now() - started >= 1_900, "not before the cap");
    assert.match(twilio.calls[0].updates[0], /<Say>[^<]*goodbye\.<\/Say><Hangup\/>/i);
    await running.waitForIdle();
    const record = (await readCallLedger(timed.cwd)).find((entry) => entry.kind === "call.record");
    assert.ok(record && record.kind === "call.record");
    assert.equal(record.id, placed.callId);
    assert.equal(record.endedBy, "time-cap");
  } finally {
    await running.close();
    await rm(timed.cwd, { recursive: true, force: true });
  }

  // Spend cap: the model's usage pushes the call over maxUsdPerCall.
  const spent = await workspace("2a-spend", twilio, { maxUsdPerCall: 0.05 });
  const costly = scriptedTurns((input) => ({ say: input.heard ? "Let me check the calendar." : "I'm calling to move an appointment.", usd: input.heard ? 0.06 : 0.001 }));
  running = await startGatewayServer({ config: stubModelConfig(llm.url), gateway: spent.gateway, cwd: spent.cwd, env: spent.env, callApproval: async () => "approve", callTurnRunner: costly.runner }, 0);
  try {
    await running.calls!.requestCall({ contact: "dentist", brief: BRIEF });
    const play = await twilio.play(twilio.calls[1], [{ say: "Which day?" }, { say: "Hello?" }], { duration: 20 });
    assert.match(play.heard[0], /^Hi, this is an AI assistant calling for Dhairya/);
    assert.equal(play.ended, "api");
    assert.equal(twilio.calls[1].updates.length, 1, "ended through the API");
    await running.waitForIdle();
    const record = (await readCallLedger(spent.cwd)).find((entry) => entry.kind === "call.record");
    assert.ok(record && record.kind === "call.record");
    assert.equal(record.endedBy, "spend-cap");
    assert.ok(record.costUsd >= 0.06, `cost ${record.costUsd} includes model usage`);
  } finally {
    await running.close();
    await llm.close();
    await twilio.close();
    await rm(spent.cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-25-2B (docs/spec/clauses/25-calls-sms.md#mus-spec-25-2b--after-the-call-record-summary-and-fallback)
test("completed calls are recorded and summarised, unanswered calls fall back", async () => {
  const twilio = await startFakeTwilio();
  const { cwd, gateway, env } = await workspace("2b", twilio);
  const llm = await startStubModel("unused");
  const turns = scriptedTurns((input) => input.heard
    ? { say: "Thursday at four it is. Goodbye.", hangup: true, outcome: "Moved to Thursday 4pm, no fee.", usd: 0.002 }
    : { say: "I'm calling to move Dhairya's 3pm appointment.", usd: 0.001 });
  const running = await startGatewayServer({ config: stubModelConfig(llm.url), gateway, cwd, env, callApproval: async () => "approve", callTurnRunner: turns.runner }, 0);
  try {
    // 1. Completed.
    const completed = await running.calls!.requestCall({ contact: "dentist", brief: BRIEF });
    await twilio.play(twilio.calls[0], [{ say: "Thursday at four works" }], { duration: 72 });
    await running.waitForIdle();
    const summary = twilio.messages().find((message) => message.body.startsWith("☎ Call with dentist"));
    assert.ok(summary, JSON.stringify(twilio.messages()));
    assert.equal(summary.to, OWNER);
    const lines = summary.body.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^☎ Call with dentist: completed in 1m 12s, \$0\.03\.$/);
    assert.equal(lines[1], "Outcome: Moved to Thursday 4pm, no fee.");
    assert.match(lines[2], /^Transcript: .*calls\/call_[0-9a-f]+\.transcript\.jsonl$/);
    const record = (await readCallLedger(cwd)).find((entry) => entry.kind === "call.record" && entry.id === completed.callId);
    assert.ok(record && record.kind === "call.record");
    assert.equal(record.contact, "dentist");
    assert.equal(record.outcome, "completed");
    assert.equal(record.durationSeconds, 72);
    assert.equal(record.costUsd, 0.031);
    const transcript = (await readFile(record.transcriptPath!, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { speaker: string; text: string });
    assert.deepEqual(transcript.map((line) => line.speaker), ["agent", "agent", "callee", "agent"]);

    // 2. No answer, the brief allows a text: the brief goes to the contact by SMS.
    const unanswered = await running.calls!.requestCall({ contact: "dentist", brief: BRIEF, smsFallback: true });
    assert.equal((await twilio.status(twilio.calls[1], "no-answer")).status, 200);
    await running.waitForIdle();
    const texted = twilio.messages().find((message) => message.to === DENTIST);
    assert.ok(texted, JSON.stringify(twilio.messages()));
    assert.equal(texted.body, `Hi, this is an AI assistant for Dhairya. ${BRIEF}`);

    // 3. No answer, no text allowed: the owner is asked.
    await running.calls!.requestCall({ contact: "dentist", brief: BRIEF });
    assert.equal((await twilio.status(twilio.calls[2], "no-answer")).status, 200);
    await running.waitForIdle();
    assert.equal(twilio.messages().at(-1)?.body, "No answer from dentist; want me to try later?");
    assert.equal(twilio.messages().at(-1)?.to, OWNER);

    const records = (await readCallLedger(cwd)).filter((entry) => entry.kind === "call.record");
    assert.deepEqual(records.map((entry) => entry.kind === "call.record" && [entry.outcome, entry.fallback ?? "-"]), [["completed", "-"], ["no-answer", "sms"], ["no-answer", "owner-notified"]]);
    const table = formatCallRecordsTable(await readCallLedger(cwd)).split("\n");
    assert.equal(table[0], "id\twhen\tcontact\toutcome\tduration\tcost\tfallback");
    assert.match(table[1], new RegExp(`^${completed.callId}\\t.*\\tdentist\\tcompleted\\t1m 12s\\t\\$0\\.03\\t-$`));
    assert.match(table[2], new RegExp(`^${unanswered.callId}\\t.*\\tdentist\\tno-answer\\t0m 00s\\t\\$0\\.00\\tsms$`));
  } finally {
    await running.close();
    await llm.close();
    await twilio.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-25-3A (docs/spec/clauses/25-calls-sms.md#mus-spec-25-3a--webhooks-are-signed-and-replay-protected)
test("call webhooks verify signatures and ignore replays and stale requests", async () => {
  const twilio = await startFakeTwilio();
  const { cwd, gateway, env } = await workspace("3a", twilio);
  const llm = await startStubModel("unused");
  const running = await startGatewayServer({ config: stubModelConfig(llm.url), gateway, cwd, env, callApproval: async () => "approve", callTurnRunner: async () => ({ say: "hi" }) }, 0);
  try {
    const placed = await running.calls!.requestCall({ contact: "dentist", brief: BRIEF });
    const call = twilio.calls[0];
    const fresh: Array<[string, string]> = [["AccountSid", twilio.accountSid], ["CallSid", call.sid], ["CallStatus", "no-answer"], ["Timestamp", new Date().toUTCString()]];
    const records = async () => (await readCallLedger(cwd)).filter((entry) => entry.kind === "call.record").length;

    const first = await postSigned(call.statusCallback, fresh, twilio.authToken);
    assert.equal(first.status, 200);
    await running.waitForIdle();
    assert.equal(running.calls!.webhookStats().processed, 1);
    assert.equal(await records(), 1);

    const replay = await postSigned(call.statusCallback, fresh, twilio.authToken);
    assert.equal(replay.status, 200);
    assert.deepEqual(running.calls!.webhookStats(), { processed: 1, replays: 1, rejected: 0 }, "the replay is not processed again");

    const forged = await postSigned(call.statusCallback, [...fresh.slice(0, 3), ["Timestamp", new Date(Date.now() + 1000).toUTCString()]], twilio.authToken, { signature: twilioSignature("wrong-token", call.statusCallback, fresh) });
    assert.equal(forged.status, 403);

    const old: Array<[string, string]> = [...fresh.slice(0, 3), ["Timestamp", new Date(Date.now() - 10 * 60_000).toUTCString()]];
    const stale = await postSigned(call.statusCallback, old, twilio.authToken);
    assert.equal(stale.status, 403);

    // A signature for another URL (another call id) does not verify here either.
    const moved = await postSigned(call.statusCallback, fresh, twilio.authToken, { signature: twilioSignature(twilio.authToken, call.statusCallback.replace(placed.callId!, "call_other"), fresh) });
    assert.equal(moved.status, 403);
    assert.deepEqual(running.calls!.webhookStats(), { processed: 1, replays: 1, rejected: 3 });
    assert.equal(await records(), 1);
  } finally {
    await running.close();
    await llm.close();
    await twilio.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
