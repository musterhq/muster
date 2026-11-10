import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { startFakeMatrixHomeserver } from "../../gateway/test/fakes/matrix-homeserver.js";
import { startFakeImapServer, startFakeSmtpServer } from "../../gateway/test/fakes/mail-servers.js";

const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");

function runCli(args: readonly string[], cwd: string, env: Record<string, string> = {}): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile("tsx", [cliPath, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1", MUSTER_ONBOARDING_HOME: join(cwd, ".home"), ...env },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolvePromise({ code, stdout, stderr });
    });
  });
}

// Spec: MUS-SPEC-18-5A
test("channels setup matrix and email store env references and doctor --live proves the connection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-channels-sdk-cli-"));
  const matrix = await startFakeMatrixHomeserver();
  const imap = await startFakeImapServer();
  const smtp = await startFakeSmtpServer();
  try {
    const refused = await runCli(["channels", "setup", "matrix", "--homeserver", matrix.url, "--user-id", matrix.botUserId, "--access-token", matrix.token], cwd);
    assert.notEqual(refused.code, 0);
    assert.match(`${refused.stdout}${refused.stderr}`, /--access-token-env/);

    const setupMatrix = await runCli([
      "channels", "setup", "matrix",
      "--homeserver", matrix.url,
      "--user-id", matrix.botUserId,
      "--access-token-env", "MATRIX_TOKEN",
      "--allow-from", "@alice:fake.test,@bob:fake.test",
    ], cwd);
    assert.equal(setupMatrix.code, 0, setupMatrix.stderr);
    assert.match(setupMatrix.stdout, /channel=matrix configured=true/);

    const setupEmail = await runCli([
      "channels", "setup", "email",
      "--address", "muster@corp.test",
      "--imap-host", "127.0.0.1", "--imap-port", String(imap.port), "--imap-security", "none",
      "--smtp-host", "127.0.0.1", "--smtp-port", String(smtp.port), "--smtp-security", "none",
      "--username", "muster",
      "--password-env", "MAIL_PASSWORD",
      "--allow-from", "*@corp.test",
    ], cwd);
    assert.equal(setupEmail.code, 0, setupEmail.stderr);
    assert.match(setupEmail.stdout, /channel=email configured=true/);

    const raw = await readFile(join(cwd, ".muster", "gateway.json"), "utf8");
    assert.ok(!raw.includes(matrix.token));
    assert.ok(!raw.includes("imap-secret"));
    const saved = JSON.parse(raw) as { channels: { matrix: Record<string, unknown>; email: { imap: Record<string, unknown>; smtp: Record<string, unknown>; allowFrom: string[] } } };
    assert.equal(saved.channels.matrix.accessTokenEnv, "MATRIX_TOKEN");
    assert.deepEqual(saved.channels.matrix.allowFrom, ["@alice:fake.test", "@bob:fake.test"]);
    assert.equal(saved.channels.email.imap.passwordEnv, "MAIL_PASSWORD");
    assert.equal(saved.channels.email.smtp.passwordEnv, "MAIL_PASSWORD");
    assert.deepEqual(saved.channels.email.allowFrom, ["*@corp.test"]);

    const missingEnv = await runCli(["channels", "doctor", "matrix", "--live"], cwd);
    assert.notEqual(missingEnv.code, 0);
    assert.match(missingEnv.stdout, /check=access_token status=fail .*MATRIX_TOKEN/);
    assert.match(missingEnv.stdout, /doctor=matrix status=fail/);

    const matrixDoctor = await runCli(["channels", "doctor", "matrix", "--live"], cwd, { MATRIX_TOKEN: matrix.token });
    assert.equal(matrixDoctor.code, 0, matrixDoctor.stdout);
    assert.match(matrixDoctor.stdout, /check=whoami status=ok/);
    assert.match(matrixDoctor.stdout, /doctor=matrix status=ok/);
    assert.ok(!matrixDoctor.stdout.includes(matrix.token));

    const emailDoctor = await runCli(["channels", "doctor", "email", "--live"], cwd, { MAIL_PASSWORD: "imap-secret" });
    assert.equal(emailDoctor.code, 0, emailDoctor.stdout);
    assert.match(emailDoctor.stdout, /check=imap_login status=ok/);
    assert.match(emailDoctor.stdout, /check=smtp_auth status=ok/);
    assert.match(emailDoctor.stdout, /doctor=email status=ok/);
    assert.ok(!emailDoctor.stdout.includes("imap-secret"));
  } finally {
    await matrix.close();
    await imap.close();
    await smtp.close();
  }
});

// Spec: MUS-SPEC-18-6A
test("a due reminder is delivered to a Matrix room", { timeout: 120_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-channels-deliver-"));
  const matrix = await startFakeMatrixHomeserver();
  try {
    const setup = await runCli(["channels", "setup", "matrix", "--homeserver", matrix.url, "--user-id", matrix.botUserId, "--access-token-env", "MATRIX_TOKEN", "--allow-from", "@alice:fake.test"], cwd);
    assert.equal(setup.code, 0, setup.stderr);
    const at = new Date(Date.now() + 2_000).toISOString();
    const scheduled = await runCli(["schedule", "remind", at, "stand up and stretch", "--deliver", "channel:matrix/!room:fake.test"], cwd);
    assert.equal(scheduled.code, 0, scheduled.stderr);
    await new Promise((done) => setTimeout(done, 2_500));
    const tick = await runCli(["daemon", "--once"], cwd, { MATRIX_TOKEN: matrix.token });
    assert.equal(tick.code, 0, tick.stderr);
    assert.ok(matrix.sent.some((event) => JSON.stringify(event).includes("stand up and stretch") && JSON.stringify(event).includes("!room:fake.test")), JSON.stringify(matrix.sent));
    const bad = await runCli(["schedule", "remind", "in 5m", "x", "--deliver", "channel:matrix"], cwd);
    assert.notEqual(bad.code, 0);
    assert.match(`${bad.stdout}${bad.stderr}`, /channel:<channel>\/<peer>/);
  } finally {
    await matrix.close();
  }
});
