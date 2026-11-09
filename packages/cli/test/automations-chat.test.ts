import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAutomation, daemonJobFilter, runAutomationsTick, type AutomationNotice } from "@musterhq/core";
import { attachChatAutomations, handleAutomationCommand } from "../src/chat-automations.js";
import { createMusterChatHarness, stripCardMark } from "../src/chat-tui.js";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(stripCardMark(line)));

// Spec: MUS-SPEC-16-3C (docs/spec/clauses/16-automations.md#mus-spec-16-3c--a-reminder-appears-as-a-card-in-the-open-chat)
test("an open chat shows a due reminder as a card, once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-automations-chat-"));
  const t0 = new Date("2026-11-09T10:00:00.000Z");
  let clock = t0;
  let ticker: ReturnType<typeof attachChatAutomations> | undefined;
  const harness = createMusterChatHarness({
    commands: [], toolsets: [], recentSessions: () => [], agents: async () => [],
    onReady: (sink) => {
      ticker = attachChatAutomations(sink, { cwd, clock: () => clock, intervalMs: 0 });
      return () => ticker?.stop();
    },
  });
  try {
    assert.ok(ticker, "the chat attached its automations ticker");
    await createAutomation({ kind: "reminder", text: "stretch", when: "in 5m", deliver: "terminal", now: t0, cwd });
    clock = new Date(t0.getTime() + 5 * 60_000);

    // A daemon ticking at the same moment leaves terminal reminders to the open chat.
    const daemonDelivered: AutomationNotice[] = [];
    const daemonRun = await runAutomationsTick({ cwd, now: clock, only: daemonJobFilter(cwd), deliverers: { terminal: (notice) => { daemonDelivered.push(notice); } } });
    assert.equal(daemonRun.length, 0);
    assert.equal(daemonDelivered.length, 0);

    await ticker!.tick();
    const cards = plain(harness.transcript()).filter((line) => /reminder/i.test(line) && line.includes("stretch"));
    assert.equal(cards.length, 1, plain(harness.transcript()).join("\n"));
    assert.ok(harness.transcript().some((line) => line !== stripCardMark(line)), "rendered as a card band");

    clock = new Date(clock.getTime() + 60_000);
    await ticker!.tick();
    assert.equal(plain(harness.transcript()).filter((line) => line.includes("stretch")).length, 1);
  } finally {
    ticker?.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-16-5A (docs/spec/clauses/16-automations.md#mus-spec-16-5a--an-automations-table-in-the-cli-and-chat)
test("/remind schedules and /schedule list shows it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-automations-chat-"));
  const now = new Date("2026-11-09T10:00:00.000Z");
  try {
    const echoed = plain(await handleAutomationCommand("remind", "in 10m drink water", { cwd, now }));
    assert.ok(echoed.some((line) => line.includes("drink water") && line.includes("2026-11-09T10:10:00")), echoed.join("\n"));

    const usage = plain(await handleAutomationCommand("remind", "", { cwd, now }));
    assert.match(usage.join("\n"), /\/remind <when> <message>/);

    const table = plain(await handleAutomationCommand("schedule", "list", { cwd, now }));
    const header = table.find((line) => line.includes("ID"))!;
    for (const column of ["ID", "KIND", "NEXT RUN", "LAST RUN", "RESULT", "ENABLED"]) assert.ok(header.includes(column), header);
    const row = table.find((line) => line.includes("drink water"))!;
    assert.match(row, /reminder/);
    const id = row.trim().split(/\s+/)[0]!;

    const ran = plain(await handleAutomationCommand("schedule", `run ${id}`, { cwd, now }));
    assert.ok(ran.some((line) => line.includes("drink water")), ran.join("\n"));
    const removed = plain(await handleAutomationCommand("schedule", `remove ${id}`, { cwd, now }));
    assert.match(removed.join("\n"), new RegExp(`Removed ${id}`));
    assert.match(plain(await handleAutomationCommand("schedule", "list", { cwd, now })).join("\n"), /No automations/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
