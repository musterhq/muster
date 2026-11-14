# 25 — Phone calls and SMS: the agent calls only with your approval, and only numbers you allow

Muster can place outbound phone calls and send or receive SMS through Twilio, with Telnyx as the second provider. Calls are **governed**:
- every call needs an approval card, unless the call is to the owner's own number and the owner opted into `calls.autoApproveOwner`;
- SMS can carry cards and summaries, but an SMS cannot approve a card or steer a call unless the owner opts into `calls.allowSmsApprovals` (SMS caller ID can be spoofed). Decisions come from a non-SMS `calls.notify` channel, such as Telegram, or from the chat harness;
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
    "notify": { "channel": "telegram", "peer": "123456789" },
    "allowSmsApprovals": false,
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
- **Evidence:** green 2026-11-11 on `feat/calls-sms`: red `12e53c0` (`Cannot find module src/twilio.js`) → green `03fcba1`; `npx tsx --test --test-concurrency=1 test/calls.test.ts` 5/5. Live 2026-11-11: the real `muster gateway start --port 7525` against the fake Twilio REST server and TwiML callee, a local stub model, and `muster mcp serve` (`~/.muster-work/review/screens/calls-25/evidence.txt`): `call_contact` with `+15559999999` and `unknown` returned isError "call_contact takes a contact name from calls.contacts (owner, dentist)."; with `dentist` it returned `awaiting_approval` and the card was texted to the owner (`☎ Call dentist (+1 555-765-4321)?` / brief / `Cap: 15 s · $0.50` / `y call · n cancel`); Calls.json count stayed 0 until the owner texted `y`, then `To=+15557654321` with the status callback URL and `TimeLimit=30`.

## MUS-SPEC-25-1B — Approvals during a call fail closed

- **Precondition:** a call in progress; the model in the call asks for a tool that needs approval (e.g. a file edit).
- **Action:** the tool request arrives.
- **Expected result:**
  - The request is declined without prompting on the call. A text message goes to the owner's channel: "During the call with dentist the agent asked to edit notes.md; approve it here after the call".
  - Texts the owner sends during a call go into the call's context, as a steer, not into a second reply. Over SMS this needs `calls.allowSmsApprovals` (MUS-SPEC-25-1C).
- **Test:** `packages/gateway/test/calls.test.ts` › "approvals during a call are declined and routed to the text channel"
- **Environment:** fake call session.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11: red `12e53c0` → green `03fcba1`; `test/calls.test.ts` 5/5. The in-call turn's approval request was declined, the owner got "During the call with dentist the agent asked to edit notes.md; approve it here after the call" by SMS, and an owner text during the call reached the next turn as a steer with no model turn of its own (reply "Passed to the call with dentist."). Not run live (it needs a model that requests a gated tool).

## MUS-SPEC-25-1C — SMS cannot approve or steer a call by default

- **Precondition:** the config above without `calls.notify`, so cards go to the owner by SMS; `calls.allowSmsApprovals` unset; a fake Twilio API.
- **Action:**
  1. `call_contact` for `dentist` with no in-process approver, then an SMS `y` from the owner's number;
  2. during a call, an SMS steer from the owner's number;
  3. the same `y` with `calls.allowSmsApprovals: true`;
  4. with `calls.notify` = `{ "channel": "telegram", "peer": "T1" }`, a `y` from Telegram sender T1, and an SMS `y`.
- **Expected result:**
  - `call_contact` returns `awaiting_approval` with a message that SMS replies can't approve calls and the owner must reply on a non-SMS channel. The card ends "Reply y on a paired chat channel such as Telegram (set calls.notify); SMS replies can't approve calls."
  - An SMS `y`/`n` on a pending card, or an SMS steer, gets one reply: "SMS can't approve or steer calls (caller ID can be spoofed). Answer on <the non-SMS `calls.notify` channel, else 'a paired chat channel such as Telegram'>, or set calls.allowSmsApprovals in gateway.json if you accept that risk." The card stays pending, nothing is dialled, and the call does not get the steer. Each refusal writes a `call.sms-approval-refused` ledger entry with the action, contact, sender and at most 80 characters of the message.
  - With `calls.allowSmsApprovals: true`, SMS approvals and steers work as before.
  - With a Telegram `calls.notify`, the owner's `y` on Telegram places the call; an SMS `y` is refused.
  - Cards, summaries and notices are still texted over SMS. Only decisions and steers are gated.
- **Test:** `packages/gateway/test/calls.test.ts` › "sms cannot approve or steer a call unless allowSmsApprovals is set"
- **Environment:** fake Twilio REST; owner messages as `SurfaceMessage`s straight to the call manager.
- **Known gaps:** with SMS as the only notify channel and no opt-in, nothing can approve a card until `calls.notify` names a chat channel (the card and the tool message say so).
- **Evidence:** UNVERIFIED (filled in by the next commit).

## MUS-SPEC-25-2A — The first sentence discloses the AI, and the cap ends the call

- **Precondition:** an approved call; a fake media stream.
- **Action:** the callee answers; the call runs past `maxMinutes` (shortened to 2 s in the test).
- **Expected result:**
  - The first outbound utterance starts with "Hi, this is an AI assistant calling for <owner name>".
  - At the cap the agent says a short goodbye and the call is ended through the API.
  - Spend is tracked from provider pricing plus model usage. Reaching `maxUsdPerCall` also ends the call.
- **Test:** `packages/gateway/test/calls.test.ts` › "the call opens with an AI disclosure and ends at the time or spend cap"
- **Environment:** a fake media-stream WebSocket.
- **Known gaps:** realtime speech (OpenAI realtime, Gemini Live over a media stream) is not built yet: calls use `<Gather input="speech">` and `<Say>`, and a configured `calls.realtime` only logs that. Telnyx (ed25519 webhooks) is not built; `provider: "telnyx"` is refused. Model spend is estimated from prompt and reply length.
- **Evidence:** green 2026-11-11: red `12e53c0` → green `03fcba1`; `test/calls.test.ts` 5/5 (time cap 2 s; spend cap 0.05 with a 0.06 model turn). The fake media stream is the TwiML callee in `test/fakes/twilio.ts`, because this slice carries speech over `<Gather>`/`<Say>`. Live 2026-11-11: the real `muster gateway start --port 7525` against the fake Twilio REST server and TwiML callee, a local stub model, and `muster mcp serve` (`~/.muster-work/review/screens/calls-25/evidence.txt`): the callee first heard "Hi, this is an AI assistant calling for Dhairya."; at the 15 s cap the gateway posted `Calls/CA…04.json` with `<Say>I have to wrap up this call now. Thank you, goodbye.</Say><Hangup/>` and the call ended (`ended=api after 15.0 s`).

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
- **Evidence:** green 2026-11-11: red `12e53c0` → green `03fcba1` (`muster calls list` in `06408b1`); `test/calls.test.ts` 5/5. Live 2026-11-11: the real `muster gateway start --port 7525` against the fake Twilio REST server and TwiML callee, a local stub model, and `muster mcp serve` (`~/.muster-work/review/screens/calls-25/evidence.txt`): `calls.jsonl` got one `call.record` (`outcome: completed`, `endedBy: time-cap`, 15 s, $0.0148, transcript path); the owner got the 3-line summary by SMS; `muster calls list` printed the row. The no-answer SMS fallback and the owner question are covered by the test only.

## MUS-SPEC-25-3A — Webhooks are signed and replay-protected

- **Precondition:** gateway with the Twilio auth token set.
- **Action:** POST a status callback with a valid signature; the same body again; one with a bad signature; one with a valid signature but a timestamp 10 minutes old.
- **Expected result:** the first gets 200 and is processed once. The replay gets 200 but is not processed again. The bad signature gets 403. The stale one gets 403.
- **Test:** `packages/gateway/test/calls.test.ts` › "call webhooks verify signatures and ignore replays and stale requests"
- **Environment:** the real gateway HTTP server.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11: red `12e53c0` → green `03fcba1`; `test/calls.test.ts` 5/5: valid → 200 and processed once; the same body → 200, counted as a replay and not processed; wrong token → 403; a 10-minute-old `Timestamp` → 403; a signature for another call's URL → 403. Live: a forged SMS webhook → 403; the gateway log never contained the auth token.

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
- **Evidence:** green 2026-11-11: red `5658d23` run against the pre-implementation sources of `12e53c0` (`does not provide an export named 'twilioSignature'`); the adapter landed in `03fcba1`, ahead of its test; `npx tsx --test --test-concurrency=1 test/sms-channel.test.ts` 1/1. Live 2026-11-11: the real `muster gateway start --port 7525` against the fake Twilio REST server and TwiML callee, a local stub model, and `muster mcp serve` (`~/.muster-work/review/screens/calls-25/evidence.txt`): the owner's first text got the pairing challenge (`muster pairing approve GAPZ5SQ7`), and after approval "what is 2+2" was answered "four" through Messages.json.

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
- **Evidence:** green 2026-11-11: red `5658d23` against the pre-implementation sources (`running.calls` undefined); green `ad23d24`; `npx tsx --test --test-concurrency=1 test/calls-sim.test.ts` 1/1, about 3.1 s. The transcript has six turns in order, the 3 s tool is covered by "One moment." with the longest silence under 1.5 s, the dropped request is retried and answered as a replay without rerunning the turn, and exactly one record is written.
