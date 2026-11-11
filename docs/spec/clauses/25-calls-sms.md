# 25 — Phone calls and SMS: the agent calls only with your approval, and only numbers you allow

Muster can place outbound phone calls and send or receive SMS through Twilio, with Telnyx as the second provider. Calls are **governed**:
- every call needs an approval card, unless the call is to the owner's own number and the owner opted into `calls.autoApproveOwner`;
- calls go only to numbers on the allowlist;
- the agent says it is an AI in its first sentence;
- every call has a written brief (purpose, what it may agree to, when to hang up) and a spend cap;
- the transcript, outcome and cost land in the ledger.

No tool takes a raw phone number. The model names a contact from the allowlist (`owner`, `dentist`), so a prompt injection cannot dial anyone else.

Webhooks are signature-checked (`X-Twilio-Signature`; Telnyx ed25519), replay-protected (timestamp window plus a nonce store), and exposed through the gateway's public URL or a tunnel. Speech in calls uses a realtime model when configured (OpenAI realtime or Gemini Live). Otherwise it uses the spec 21 STT→turn→TTS loop over the provider's `<Gather>`/`<Say>`.

Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

Config (`gateway.json`):
```json
{
  "calls": {
    "provider": "twilio",
    "accountSidEnv": "TWILIO_ACCOUNT_SID",
    "authTokenEnv": "TWILIO_AUTH_TOKEN",
    "from": "+15550001111",
    "contacts": { "owner": "+15551234567", "dentist": "+15557654321" },
    "maxMinutes": 5,
    "maxUsdPerCall": 0.5,
    "autoApproveOwner": false,
    "realtime": { "provider": "openai", "apiKeyEnv": "OPENAI_API_KEY" }
  },
  "sms": { "enabled": true }
}
```

## MUS-SPEC-25-1A — `call_contact` needs a known contact and an approved brief

- **Precondition:** the config above; a fake Twilio API.
- **Action:** the model calls the `call_contact` tool with `{contact: "dentist", brief: "Move my 3pm to Thursday; do not agree to fees"}`; then with `{contact: "+15559999999"}`; then with `{contact: "unknown"}`.
- **Expected result:**
  - The first shows an approval card: `☎ Call dentist (+1 555-765-4321)?`, then the brief, cap `5 min · $0.50`, and keys `y` / `n`. No call is placed until `y`. On `y`, Twilio `Calls.json` is called with `To` = the dentist's number and a status callback URL.
  - The second and third are refused without a card: "call_contact takes a contact name from calls.contacts". The refusal is written to the ledger.
- **Test:** `packages/gateway/test/calls.test.ts` › "call_contact dials only named contacts after approval"
- **Environment:** fake Twilio REST; harness approval sink.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-25-1B — Approvals during a call fail closed

- **Precondition:** a call in progress; the model in the call asks for a tool that needs approval (e.g. a file edit).
- **Action:** the tool request arrives.
- **Expected result:**
  - The request is declined without prompting on the call. A text message goes to the owner's channel: "During the call with dentist the agent asked to edit notes.md; approve it here after the call".
  - Texts the owner sends during a call go into the call's context, as a steer, not into a second reply.
- **Test:** `packages/gateway/test/calls.test.ts` › "approvals during a call are declined and routed to the text channel"
- **Environment:** fake call session.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-25-2A — The first sentence discloses the AI, and the cap ends the call

- **Precondition:** an approved call; a fake media stream.
- **Action:** the callee answers; the call runs past `maxMinutes` (shortened to 2 s in the test).
- **Expected result:**
  - The first outbound utterance starts with "Hi, this is an AI assistant calling for <owner name>".
  - At the cap the agent says a short goodbye and the call is ended through the API.
  - Spend is tracked from provider pricing plus model usage. Reaching `maxUsdPerCall` also ends the call.
- **Test:** `packages/gateway/test/calls.test.ts` › "the call opens with an AI disclosure and ends at the time or spend cap"
- **Environment:** a fake media-stream WebSocket.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-25-2B — After the call: record, summary and fallback

- **Precondition:** one call that completes; one that is not answered (status `no-answer`).
- **Action:** status callbacks arrive.
- **Expected result:**
  - The completed call writes a record to `calls.jsonl` with contact, duration, cost, outcome and transcript path, and the owner gets a 3-line summary on their default channel.
  - The unanswered call sends the brief as an SMS to the contact if `sms.enabled` and the brief allows it. Otherwise the owner gets "No answer from dentist; want me to try later?"
  - `muster calls list` shows both.
- **Test:** `packages/gateway/test/calls.test.ts` › "completed calls are recorded and summarised, unanswered calls fall back"
- **Environment:** fake callbacks.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-25-3A — Webhooks are signed and replay-protected

- **Precondition:** gateway with the Twilio auth token set.
- **Action:** POST a status callback with a valid signature; the same body again; one with a bad signature; one with a valid signature but a timestamp 10 minutes old.
- **Expected result:** the first gets 200 and is processed once. The replay gets 200 but is not processed again. The bad signature gets 403. The stale one gets 403.
- **Test:** `packages/gateway/test/calls.test.ts` › "call webhooks verify signatures and ignore replays and stale requests"
- **Environment:** the real gateway HTTP server.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-25-4A — SMS is a channel on the SDK

- **Precondition:** `sms.enabled`; the owner paired; a fake Twilio API.
- **Action:** an inbound SMS webhook from the owner; one from an unknown number; then an outbound `sendToChannel("sms", "owner", …)` of 400 characters.
- **Expected result:**
  - The owner's SMS starts a turn and the reply is sent via `Messages.json`.
  - The unknown number gets the pairing challenge.
  - Outbound text is split at 1600 characters per message (the Twilio concatenated limit) and sent to the owner's number. `sendToChannel` takes contact names, not raw numbers.
- **Test:** `packages/gateway/test/sms-channel.test.ts` › "sms inbound runs through the shared runner and outbound goes only to named contacts"
- **Environment:** fakes.
- **Known gaps:** MMS images are listed as attachments only.
- **Evidence:** UNVERIFIED

## MUS-SPEC-25-5A — A full simulated call in CI

- **Precondition:** the fake Twilio REST plus media stream.
- **Action:** a scripted call:
  1. answer;
  2. the callee says "Thursday at four works";
  3. a slow tool takes 3 s and the agent says "one moment";
  4. the socket drops and reconnects;
  5. the callee hangs up.
- **Expected result:** the transcript has every turn in order. The slow tool does not produce dead air longer than 1.5 s. The reconnect resumes the same call. The record is written once.
- **Test:** `packages/gateway/test/calls-sim.test.ts` › "a simulated call survives a slow tool and a dropped socket"
- **Environment:** fakes only; no real calls in CI.
- **Known gaps:** real-network calls are a manual release check.
- **Evidence:** UNVERIFIED
