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
- **Evidence:** green 2026-11-11 on `feat/channels-sdk-2`: red `97219f6` (`channelRegistryTable` not exported) → green `6bbee33`; `npx tsx --test --test-concurrency=1 test/channel-sdk.test.ts` 6/6. `muster channels list` printed the nine-row table (`discord\tDiscord\tyes\tyes\t2000\tnot configured` …). The 18-1A registry assertion now checks that its four channels stay registered instead of an exact list.

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
- **Known gaps:** voice channels are not handled (spec 21 next slices). Attachments in Discord messages are ignored. The worker runs one shard.
- **Evidence:** green 2026-11-11 on `feat/channels-sdk-2`: red `3d03345` (`runDiscordGateway` not exported) → green `ed30982`; `npx tsx --test --test-concurrency=1 test/discord-gateway.test.ts` 2/2, three consecutive runs. Live: the real `muster gateway start --port 7524 --with-discord` against the fake gateway and REST server sent IDENTIFY with intents 37376, answered a DM with `message_reference` to the inbound id, and after a dropped socket resumed with RESUME (`session-1`); no secret in the gateway log (`~/.muster-work/review/screens/channels-24/evidence.json`).

## MUS-SPEC-24-2B — Discord approvals use buttons and only the requester can press them

- **Precondition:** a turn that needs approval, requested by U, in a guild channel.
- **Action:** the fake sends an `INTERACTION_CREATE` button press from user V, then from U.
- **Expected result:** the approval message carries Approve/Deny buttons. V's press gets an ephemeral "only the person who asked can approve this". U's press resolves the gate and edits the message to show the decision.
- **Test:** `packages/gateway/test/discord-gateway.test.ts` › "discord approval buttons resolve only for the requester"
- **Environment:** as 24-2A.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11 on `feat/channels-sdk-2`: red `3d03345` → green `ed30982`; `test/discord-gateway.test.ts` 2/2. V's press got callback type 4 with flags 64 "Only the person who asked can approve this."; U's press got callback type 7 (components cleared) and the flow run completed once.

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
- **Evidence:** green 2026-11-11 on `feat/channels-sdk-2`: red `476aa9b` (0 Graph sends, expected 1) → green `1ee2709`; `npx tsx --test --test-concurrency=1 test/whatsapp-sdk.test.ts` 2/2; `test/adapters-wave2.test.ts` 22/22 unchanged. No live run: the Graph host is fixed, so a live gateway would contact Meta; the test drives the real gateway HTTP server with the fake Graph API behind the injected fetcher.

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
- **Evidence:** green 2026-11-11 on `feat/channels-sdk-2`: red `45106d0` (`createWhatsAppChannel` not exported) → green `12c8420`; `test/whatsapp-sdk.test.ts` 2/2; `test/whatsapp-personal.test.ts` 5/5 unchanged. No live run (it needs a real linked device).

## MUS-SPEC-24-4A — Google Chat answers in the thread and verifies the bearer token

- **Precondition:** googlechat configured with a project number; a fake token verifier; a fake Chat API.
- **Action:** POST a `MESSAGE` event in space S, thread T; POST another with a token for the wrong audience.
- **Expected result:** the first gets a synchronous acknowledgement. The reply is created with `POST spaces/S/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` in thread T. The second gets 401.
- **Test:** `packages/gateway/test/googlechat-sdk.test.ts` › "google chat replies in thread and rejects tokens for another audience"
- **Environment:** fakes.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11 on `feat/channels-sdk-2`: the test landed in `410c78b` after the implementation (`6bbee33`, wired in `1ee2709`). Red receipt: the same test against the pre-wiring tree `476aa9b` failed (`/v1/adapters/googlechat` → 404, expected 200); green at `410c78b`: `npx tsx --test --test-concurrency=1 test/googlechat-sdk.test.ts` 1/1. Live: `POST /v1/adapters/googlechat` → 200 `{}`, then `POST spaces/LIVE/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` with `thread.name` set (legacy token mode, because the bearer certificates come from Google).

## MUS-SPEC-24-5A — Teams: Bot Framework activities with proactive replies

- **Precondition:** teams configured with an app id and `appPasswordEnv`; a fake Bot Framework token endpoint and connector.
- **Action:** POST a `message` activity with a valid JWT; POST one with an invalid JWT; let a long turn run (more than 15 s, simulated).
- **Expected result:**
  - The valid activity is acknowledged at once with 202. The reply is sent later to `{serviceUrl}/v3/conversations/{id}/activities/{activityId}` with a bot token from the token endpoint, so long turns never time out.
  - The invalid JWT gets 401.
  - The legacy outgoing-webhook HMAC mode still works when configured instead.
- **Test:** `packages/gateway/test/teams-sdk.test.ts` › "teams bot framework activities are acknowledged and answered proactively; bad tokens are rejected"
- **Environment:** fakes.
- **Known gaps:** adaptive-card approvals come with buttons (24-1A); file uploads are not covered. Proactive messages to a conversation Muster has not heard from are not supported (the connector `serviceUrl` comes from a verified inbound activity).
- **Evidence:** green 2026-11-11 on `feat/channels-sdk-2`: the test landed in `410c78b` after the implementation. Red receipt: the same test against `476aa9b` failed (401, expected 202); green at `70caa66`: `npx tsx --test --test-concurrency=1 test/teams-sdk.test.ts` 1/1 (wrong signer, wrong audience, expired, wrong or missing `serviceurl` claim and a non-JWT are all 401; HMAC mode answers in the response). Live: valid activity → 202, forged → 401, reply posted to `/v3/conversations/19%3Alive/activities/live-act-1` with `Bearer live-bf-token`.

## MUS-SPEC-24-5B — Unknown signing keys cannot make the gateway refetch keys on every request

- **Precondition:** Teams in Bot Framework mode; tokens whose `kid` is not in Microsoft's key set (forged or stale).
- **Action:** five such requests in a row.
- **Expected result:** all five are rejected. The key set is loaded once (OpenID config and JWKS: 2 fetches). An unknown `kid` forces a refetch only if the cached set is at least 5 minutes old, so forged tokens cannot make the gateway hammer the key endpoints. New keys are published before Microsoft uses them, so a recent fetch already has them.
- **Test:** `packages/gateway/test/teams-sdk.test.ts` › "tokens with unknown key ids refresh the signing keys at most once per window"
- **Environment:** fake OpenID and JWKS endpoints.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11: `teams-sdk.test.ts` 2/2 (red first: before the fix, every forged token could force a key refetch).

## MUS-SPEC-24-6A — The legacy handlers are gone and every old route still answers

- **Precondition:** the gateway after this slice.
- **Action:** grep `server.ts` for `handleDiscordWebhook`, `handleWhatsAppWebhook` and `handleTeamsWebhook`, then hit every old route (`/v1/adapters/discord`, `/whatsapp-cloud`, `/teams`, `/googlechat`) with a valid fixture.
- **Expected result:** the legacy functions no longer exist. Every route is served by the SDK runner with the same status codes and response shapes as before, and all pre-existing adapter tests pass unchanged.
- **Test:** `packages/gateway/test/channel-sdk.test.ts` › "old adapter routes are served by the sdk runner with unchanged responses"
- **Environment:** the real gateway HTTP server and fixtures.
- **Known gaps:** none.
- **Evidence:** green 2026-11-11 on `feat/channels-sdk-2`: red `476aa9b` (`channelWebhookAdapter` not exported) → green `1ee2709`; `test/channel-sdk.test.ts` 6/6; the pre-existing `adapters-wave2` 22/22, `adapters` 43/43, `server` 22/22, `whatsapp-personal` 5/5, `google-chat-verifier` 3/3, `channel-matrix` 4/4, `channel-email` 3/3 and `voice-notes` 6/6 pass unchanged. `handleDiscordWebhook`, `handleWhatsAppWebhook`, `handleTeamsWebhook` and `handleGchatWebhook` no longer exist in `server.ts`.
