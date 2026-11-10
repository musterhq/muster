# 18 — Channels: the channel SDK, outbound send, Matrix and email

Every chat channel implements one `ChannelAdapter` (`packages/gateway/src/channel-sdk.ts`): verify inbound, normalize to the gateway envelope, send text chunked to the channel's limit, edit, send media, render approvals (buttons where the channel has them, a numbered text choice where it does not), pairing text and a doctor. Durable ingress, the sender allowlist, pairing and numbered approvals live in one shared path (`channel-runner.ts`), never in an adapter. `sendToChannel(channelId, peer, message)` is the one outbound API for other subsystems (automations' `channel:<id>` delivery). Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-18-1A — One registry lists every SDK channel and what it can do

- **Precondition:** default channel registry.
- **Action:** list the registry; read each adapter's capabilities.
- **Expected result:** `telegram`, `slack`, `matrix` and `email` are registered; Telegram and Slack declare buttons and edit; Matrix declares edit but no buttons; email declares neither; each declares a positive text limit (Telegram 4096).
- **Test:** `packages/gateway/test/channel-sdk.test.ts` › "the default registry lists telegram, slack, matrix and email with their capabilities"
- **Environment:** in-process.
- **Known gaps:** Discord, WhatsApp, Google Chat and Teams still run only on their legacy handlers in `server.ts`.
- **Evidence:** green 2026-11-10 on `feat/channel-sdk`: `npx tsx --test --test-concurrency=1` — gateway 11/11, CLI 1/1; live fake-server run in `~/.muster-work/review/screens/channels/`.

## MUS-SPEC-18-1B — Telegram and Slack on the SDK behave exactly as before

- **Precondition:** gateway with `telegram.secretToken` and `slack.signingSecret` configured.
- **Action:** POST a Telegram update with a wrong secret header, then a Slack event with a bad signature, to the real gateway routes; separately call the SDK adapters' `verifyInbound`, `deliveryKey` and `normalize` on the same payloads.
- **Expected result:** the routes answer 401 with the same messages as before ("Telegram secret token mismatch.", "Slack signature verification failed."); the SDK adapters reject the same requests, produce `telegram:<update_id>` / `slack:<event_id>` keys and the same envelopes as the legacy mappers. The existing adapter test files keep passing.
- **Test:** `packages/gateway/test/channel-sdk.test.ts` › "telegram and slack SDK adapters verify, key and normalize exactly like the legacy routes"
- **Environment:** real gateway HTTP server; no network.
- **Known gaps:** the Telegram/Slack webhook handlers (draft streaming, progress, Frappe onboarding) still live in `server.ts`; only verification, delivery keys, normalization and outbound send moved to the SDK.
- **Evidence:** green 2026-11-10 on `feat/channel-sdk`: `npx tsx --test --test-concurrency=1` — gateway 11/11, CLI 1/1; live fake-server run in `~/.muster-work/review/screens/channels/`.

## MUS-SPEC-18-2A — sendToChannel chunks long text to the channel limit

- **Precondition:** Telegram configured; a fake Bot API behind the injected fetcher.
- **Action:** `sendToChannel("telegram", "42", <9,000 characters>)`.
- **Expected result:** three `sendMessage` calls to chat `42`, none longer than 4096 characters, whose concatenation is the original text; the result lists three message ids.
- **Test:** `packages/gateway/test/channel-sdk.test.ts` › "sendToChannel splits long text into channel-sized messages in order"
- **Environment:** fake fetcher.
- **Known gaps:** none.
- **Evidence:** green 2026-11-10 on `feat/channel-sdk`: `npx tsx --test --test-concurrency=1` — gateway 11/11, CLI 1/1; live fake-server run in `~/.muster-work/review/screens/channels/`.

## MUS-SPEC-18-2B — sendToChannel reaches Slack threads and refuses unknown or unconfigured channels

- **Precondition:** Slack configured; Matrix not configured.
- **Action:** `sendToChannel("slack", { conversationId: "C1", replyTo: "171.5" }, "done")`; `sendToChannel("nope", …)`; `sendToChannel("matrix", …)`.
- **Expected result:** one `chat.postMessage` to `C1` with `thread_ts` `171.5`; the unknown channel throws "Unknown channel: nope"; the unconfigured one throws a message naming `muster channels setup matrix`.
- **Test:** `packages/gateway/test/channel-sdk.test.ts` › "sendToChannel posts into a Slack thread and refuses unknown or unconfigured channels"
- **Environment:** fake fetcher.
- **Known gaps:** automations' `channel:<id>` delivery is not on `main` yet; the integration is one call to `sendToChannel`.
- **Evidence:** green 2026-11-10 on `feat/channel-sdk`: `npx tsx --test --test-concurrency=1` — gateway 11/11, CLI 1/1; live fake-server run in `~/.muster-work/review/screens/channels/`.

## MUS-SPEC-18-3A — A Matrix message from an allowed sender is paired, answered and threaded

- **Precondition:** a fake Matrix homeserver; `channels.matrix` with `accessTokenEnv` set in the environment and `allowFrom: ["@alice:fake.test"]`; stub model replies "hello from muster"; the room already has history.
- **Action:** start the Matrix worker; Alice writes "hi"; the operator approves the pairing code; Alice writes "what's up".
- **Expected result:** the history is not answered; the first message is answered with a pairing code text naming `muster pairing approve`; after approval the reply "hello from muster" is sent into the same room with `m.in_reply_to` pointing at Alice's event; the bot's own messages are never answered; the access token is sent only as the bearer header.
- **Test:** `packages/gateway/test/channel-matrix.test.ts` › "matrix: an allowed sender is paired, then answered in the same room as a reply"
- **Environment:** real gateway entry point (`handleSurfaceMessage`), fake homeserver over HTTP, stub OpenAI-compatible model.
- **Known gaps:** end-to-end encrypted rooms are out of scope: encrypted events (`m.room.encrypted`) are ignored and the doctor says so.
- **Evidence:** green 2026-11-10 on `feat/channel-sdk`: `npx tsx --test --test-concurrency=1` — gateway 11/11, CLI 1/1; live fake-server run in `~/.muster-work/review/screens/channels/`.

## MUS-SPEC-18-3B — Matrix ignores senders outside the allowlist and only joins invites from allowed users

- **Precondition:** as 18-3A.
- **Action:** Mallory (not allowed) writes in the room; Mallory invites the bot to room B; Alice invites the bot to room C.
- **Expected result:** nothing is sent for Mallory and no pairing request is recorded for her; the bot joins C and not B.
- **Test:** `packages/gateway/test/channel-matrix.test.ts` › "matrix: senders and invites outside the allowlist are ignored"
- **Environment:** fake homeserver.
- **Known gaps:** none.
- **Evidence:** green 2026-11-10 on `feat/channel-sdk`: `npx tsx --test --test-concurrency=1` — gateway 11/11, CLI 1/1; live fake-server run in `~/.muster-work/review/screens/channels/`.

## MUS-SPEC-18-3C — A redelivered Matrix event is answered once (durable ingress)

- **Precondition:** paired Alice; worker processed one message but stopped before saving its sync cursor.
- **Action:** a new worker starts from the old cursor and receives the same event again.
- **Expected result:** exactly one reply exists for that event.
- **Test:** `packages/gateway/test/channel-matrix.test.ts` › "matrix: a redelivered event after a restart is answered once"
- **Environment:** fake homeserver; SQLite ingress store in a temp workspace.
- **Known gaps:** none.
- **Evidence:** green 2026-11-10 on `feat/channel-sdk`: `npx tsx --test --test-concurrency=1` — gateway 11/11, CLI 1/1; live fake-server run in `~/.muster-work/review/screens/channels/`.

## MUS-SPEC-18-3D — Approvals on a channel without buttons are a numbered choice

- **Precondition:** paired Alice in Matrix; a flow run waiting at gate `authorize`.
- **Action:** `sendToChannel("matrix", { conversationId: room, senderId: alice }, { approvalRequest })`; Alice replies "1".
- **Expected result:** the approval message ends with "Reply 1 to approve or 2 to reject."; Alice's "1" resumes the flow run past the gate; replying "1" again does not run it twice.
- **Test:** `packages/gateway/test/channel-matrix.test.ts` › "matrix: a numbered reply approves a gated flow run once"
- **Environment:** fake homeserver; real flow runtime and approval store.
- **Known gaps:** the numbered choice is bound to the one sender it was issued to; other people in the room cannot answer it.
- **Evidence:** green 2026-11-10 on `feat/channel-sdk`: `npx tsx --test --test-concurrency=1` — gateway 11/11, CLI 1/1; live fake-server run in `~/.muster-work/review/screens/channels/`.

## MUS-SPEC-18-4A — Email from an allowed sender is answered in the same thread

- **Precondition:** in-process fake IMAP and SMTP servers; `channels.email` with `passwordEnv` set and `allowFrom: ["*@corp.test"]`; Bob is paired; stub model replies "noted".
- **Action:** Bob's mail "Quarterly numbers" (Message-ID `<m1@corp.test>`) arrives; the worker polls.
- **Expected result:** one mail is sent over SMTP to Bob, from the channel address, subject "Re: Quarterly numbers", `In-Reply-To: <m1@corp.test>`, `References` containing `<m1@corp.test>`, `Auto-Submitted: auto-replied`, body "noted"; the inbound mail is flagged `\Seen`; mail that was already in the box when the worker first started is not answered.
- **Test:** `packages/gateway/test/channel-email.test.ts` › "email: an allowed sender's mail is answered in the same thread over SMTP"
- **Environment:** real gateway entry point; fake IMAP (with IDLE) and SMTP over TCP; stub model.
- **Known gaps:** HTML-only mail is reduced to text by stripping tags; attachments in inbound mail are ignored.
- **Evidence:** green 2026-11-10 on `feat/channel-sdk`: `npx tsx --test --test-concurrency=1` — gateway 11/11, CLI 1/1; live fake-server run in `~/.muster-work/review/screens/channels/`.

## MUS-SPEC-18-4B — Email ignores strangers, auto-replies and its own mail

- **Precondition:** as 18-4A.
- **Action:** mail arrives from `eve@evil.test`, from Bob with `Auto-Submitted: auto-replied`, and from the channel's own address.
- **Expected result:** no SMTP message is sent and no pairing request is recorded for any of them.
- **Test:** `packages/gateway/test/channel-email.test.ts` › "email: strangers, auto-replies and own mail are ignored"
- **Environment:** fake IMAP/SMTP.
- **Known gaps:** none.
- **Evidence:** green 2026-11-10 on `feat/channel-sdk`: `npx tsx --test --test-concurrency=1` — gateway 11/11, CLI 1/1; live fake-server run in `~/.muster-work/review/screens/channels/`.

## MUS-SPEC-18-4C — Replies in one email thread share one conversation

- **Precondition:** as 18-4A.
- **Action:** Bob replies to the bot's answer (`In-Reply-To` the bot's Message-ID, `References: <m1@corp.test> <bot-id>`).
- **Expected result:** the second inbound message has the same conversation id as the first (the thread root `<m1@corp.test>`), and the second answer's `References` carries the whole chain.
- **Test:** `packages/gateway/test/channel-email.test.ts` › "email: a reply in the thread keeps the same conversation and reference chain"
- **Environment:** fake IMAP/SMTP.
- **Known gaps:** a thread whose root was never seen by this gateway is keyed by its first `References` entry.
- **Evidence:** green 2026-11-10 on `feat/channel-sdk`: `npx tsx --test --test-concurrency=1` — gateway 11/11, CLI 1/1; live fake-server run in `~/.muster-work/review/screens/channels/`.

## MUS-SPEC-18-5A — Setup stores env-var references, and the live doctor proves the connection

- **Precondition:** a clean workspace; fake homeserver and fake IMAP/SMTP running; secrets exported as env vars.
- **Action:** `muster channels setup matrix --homeserver … --user-id … --access-token-env MATRIX_TOKEN --allow-from …`, `muster channels doctor matrix --live`; the same for `email`; then `setup matrix --access-token <value>`.
- **Expected result:** `gateway.json` holds `accessTokenEnv` / `passwordEnv` names and never the secret values; the doctor reports `whoami` / IMAP login / SMTP auth `ok` and `doctor=matrix status=ok`; with the env var unset the doctor fails naming the variable; `--access-token` is refused with a message to use an env var.
- **Test:** `packages/cli/test/channels-sdk.test.ts` › "channels setup matrix and email store env references and doctor --live proves the connection"
- **Environment:** real CLI process; fake servers.
- **Known gaps:** none.
- **Evidence:** green 2026-11-10 on `feat/channel-sdk`: `npx tsx --test --test-concurrency=1` — gateway 11/11, CLI 1/1; live fake-server run in `~/.muster-work/review/screens/channels/`.

## MUS-SPEC-18-6A — Automations deliver to a channel

- **Precondition:** Matrix is set up (`muster channels setup matrix …`); a reminder is scheduled with `--deliver channel:matrix/!room:fake.test` and is due.
- **Action:** `muster daemon --once`.
- **Expected result:** the homeserver receives the reminder text in that room; the run line reports it delivered; a target without a peer (`channel:matrix`) is refused with the expected form.
- **Test:** `packages/cli/test/channels-sdk.test.ts` › "a due reminder is delivered to a Matrix room"
- **Environment:** real CLI, fake homeserver.
- **Known gaps:** none.
- **Evidence:** UNVERIFIED
