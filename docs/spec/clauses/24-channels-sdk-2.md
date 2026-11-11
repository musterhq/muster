# 24 — Channels, slice 2: Discord, WhatsApp, Google Chat and Teams on the channel SDK

Spec 18 moved Telegram, Slack, Matrix and email onto one `ChannelAdapter` contract with a shared runner (durable ingress, allowlist, pairing, numbered approvals, voice notes from spec 21). This slice moves the rest and completes what they lack:
- **Discord** becomes a real bot. A gateway WebSocket receives DMs and @mentions in channels and threads. The existing signed slash-command interactions stay.
- **WhatsApp** is both paths: Cloud API (webhook) and personal (linked device). It moves onto the SDK, with voice notes flowing through the shared voice path.
- **Google Chat** and **Teams** answer in-thread with proper outbound APIs. Teams gets a Bot Framework reply, not only an outgoing-webhook response.

Every adapter keeps its existing verification (ed25519, HMAC, verify token, JWT) and its existing tests. The legacy handlers in `server.ts` are deleted once the SDK path covers them. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-24-1A — The registry lists all eight channels with honest capabilities

- **Precondition:** default registry.
- **Action:** list it.
- **Expected result:**
  - The registry lists `telegram`, `slack`, `matrix`, `email`, `discord`, `whatsapp-cloud`, `whatsapp`, `googlechat` and `teams`.
  - Discord, Slack, Teams and Google Chat declare buttons.
  - WhatsApp declares buttons only for Cloud (interactive replies); personal WhatsApp uses numbered choices.
  - Each channel declares its real text limit: Discord 2000, WhatsApp 4096, Google Chat 4096, Teams 28000.
  - `muster channels list` shows the same table with configured or not configured.
- **Test:** `packages/gateway/test/channel-sdk.test.ts` › "the registry lists every channel with its real capabilities"
- **Environment:** in-process.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-24-2A — Discord: DMs and @mentions over the gateway WebSocket

- **Precondition:** a fake Discord gateway (`wss`) and REST API. The bot is paired with user U.
- **Action:**
  1. The fake gateway sends HELLO, then READY.
  2. It sends `MESSAGE_CREATE` for a DM from U ("what is 2+2").
  3. A guild message that mentions the bot.
  4. A guild message that does not mention it.
  5. A message from the bot itself.
- **Expected result:**
  - Muster identifies with intents for guild messages, DMs and message content, and heartbeats at the HELLO interval.
  - The DM and the mention each start one turn. The reply goes through `POST /channels/{id}/messages` with `message_reference` to the inbound message, and a reply of more than 2000 characters is split.
  - The un-mentioned guild message and the bot's own message are ignored.
  - After the fake drops the socket, Muster resumes with `RESUME` (session id plus sequence) and re-identifies only if the resume is rejected. No message is answered twice: durable ingress keys on `discord:<message id>`.
- **Test:** `packages/gateway/test/discord-gateway.test.ts` › "discord DMs and mentions start turns over the gateway, others are ignored, and resume never double-answers"
- **Environment:** a fake gateway WebSocket server and a fake REST API.
- **Known gaps:** voice channels are not handled (spec 21 next slices).
- **Evidence:** UNVERIFIED

## MUS-SPEC-24-2B — Discord approvals use buttons and only the requester can press them

- **Precondition:** a turn that needs approval, requested by U, in a guild channel.
- **Action:** the fake sends an `INTERACTION_CREATE` button press from user V, then from U.
- **Expected result:** the approval message carries Approve/Deny buttons. V's press gets an ephemeral "only the person who asked can approve this". U's press resolves the gate and edits the message to show the decision.
- **Test:** `packages/gateway/test/discord-gateway.test.ts` › "discord approval buttons resolve only for the requester"
- **Environment:** as 24-2A.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-24-3A — WhatsApp Cloud on the SDK, including voice notes

- **Precondition:** whatsapp-cloud configured; a fake Graph API; STT on (fake whisper).
- **Action:**
  1. POST a webhook with a text message.
  2. POST one with an `audio` message (`voice: true`, media id M).
  3. POST a status-only notification.
  4. POST a body with a wrong `X-Hub-Signature-256`.
- **Expected result:**
  - The text message starts a turn and the reply is posted to `/{phoneNumberId}/messages`.
  - The audio is fetched through `GET /{M}` → url → bytes, only after the size check, then transcribed and answered with the 🎙 echo.
  - The status notification is ignored.
  - The bad signature gets 401.
  - Verification (`GET hub.challenge`) still works.
- **Test:** `packages/gateway/test/whatsapp-sdk.test.ts` › "whatsapp cloud text and voice notes run through the shared runner; statuses and bad signatures are rejected"
- **Environment:** a fake Graph API; the real gateway HTTP server.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-24-3B — Personal WhatsApp on the SDK keeps its group policy

- **Precondition:** personal WhatsApp with `activation: "mention"`, `groups: ["G1"]`; a fake linked-device socket.
- **Action:** a DM from the paired owner; a G1 message that mentions the bot; a G1 message that does not; a G2 message that mentions the bot; a voice note DM.
- **Expected result:**
  - The DM and the G1 mention are answered; the other two are ignored.
  - The voice note goes through the shared voice path.
  - The existing `whatsapp.ts` policy tests keep passing, unchanged.
- **Test:** `packages/gateway/test/whatsapp-sdk.test.ts` › "personal whatsapp on the sdk answers DMs and allowed mentions only and transcribes voice notes"
- **Environment:** a fake socket adapter.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-24-4A — Google Chat answers in the thread and verifies the bearer token

- **Precondition:** googlechat configured with a project number; a fake token verifier; a fake Chat API.
- **Action:** POST a `MESSAGE` event in space S, thread T; POST another with a token for the wrong audience.
- **Expected result:** the first gets a synchronous acknowledgement. The reply is created with `POST spaces/S/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` in thread T. The second gets 401.
- **Test:** `packages/gateway/test/googlechat-sdk.test.ts` › "google chat replies in thread and rejects tokens for another audience"
- **Environment:** fakes.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED

## MUS-SPEC-24-5A — Teams: Bot Framework activities with proactive replies

- **Precondition:** teams configured with an app id and `appPasswordEnv`; a fake Bot Framework token endpoint and connector.
- **Action:** POST a `message` activity with a valid JWT; POST one with an invalid JWT; let a long turn run (more than 15 s, simulated).
- **Expected result:**
  - The valid activity is acknowledged at once with 202. The reply is sent later to `{serviceUrl}/v3/conversations/{id}/activities/{activityId}` with a bot token from the token endpoint, so long turns never time out.
  - The invalid JWT gets 401.
  - The legacy outgoing-webhook HMAC mode still works when configured instead.
- **Test:** `packages/gateway/test/teams-sdk.test.ts` › "teams bot framework activities are acknowledged and answered proactively; bad tokens are rejected"
- **Environment:** fakes.
- **Known gaps:** adaptive-card approvals come with buttons (24-1A); file uploads are not covered.
- **Evidence:** UNVERIFIED

## MUS-SPEC-24-6A — The legacy handlers are gone and every old route still answers

- **Precondition:** the gateway after this slice.
- **Action:** grep `server.ts` for `handleDiscordWebhook`, `handleWhatsAppWebhook` and `handleTeamsWebhook`, then hit every old route (`/v1/adapters/discord`, `/whatsapp-cloud`, `/teams`, `/googlechat`) with a valid fixture.
- **Expected result:** the legacy functions no longer exist. Every route is served by the SDK runner with the same status codes and response shapes as before, and all pre-existing adapter tests pass unchanged.
- **Test:** `packages/gateway/test/channel-sdk.test.ts` › "old adapter routes are served by the sdk runner with unchanged responses"
- **Environment:** the real gateway HTTP server and fixtures.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED
