import {
  defaultChannelRegistry,
  initGatewayConfig,
  loadGatewayConfig,
  runChannelDoctor,
  saveGatewayConfig,
  sendToChannel,
} from "@musterhq/gateway";
import type { GatewayConfig, GatewayEmailChannelConfig, GatewayMailServerConfig, GatewayMatrixChannelConfig } from "@musterhq/gateway";

/**
 * `muster channels …` for channels that exist only on the channel SDK
 * (Matrix, email). Secrets are stored as env-var names, never values.
 */

export const SDK_ONLY_CHANNELS = ["matrix", "email"] as const;

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function envName(value: string | undefined, fallback: string, flagName: string): string {
  const name = value ?? fallback;
  if (!ENV_NAME.test(name)) throw new Error(`${flagName} takes an environment variable NAME such as ${fallback}, not a secret value.`);
  return name;
}

function refuseSecretFlags(args: readonly string[], refused: readonly string[], instead: string): void {
  for (const name of refused) {
    if (args.includes(name)) throw new Error(`${name} is not accepted: secrets are never stored in gateway.json. Export the secret and pass ${instead} <ENV_NAME>.`);
  }
}

function port(value: string | undefined, fallback: number, flagName: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) throw new Error(`${flagName} must be a TCP port`);
  return parsed;
}

function security(value: string | undefined, fallback: GatewayMailServerConfig["security"], flagName: string): GatewayMailServerConfig["security"] {
  const chosen = value ?? fallback;
  if (chosen !== "tls" && chosen !== "starttls" && chosen !== "none") throw new Error(`${flagName} must be tls, starttls or none`);
  return chosen;
}

function matrixSetup(existing: GatewayMatrixChannelConfig | undefined, args: readonly string[]): GatewayMatrixChannelConfig {
  refuseSecretFlags(args, ["--access-token", "--token", "--password"], "--access-token-env");
  const homeserverUrl = (flag(args, "--homeserver") ?? existing?.homeserverUrl)?.replace(/\/+$/, "");
  const userId = flag(args, "--user-id") ?? existing?.userId;
  if (!homeserverUrl || !userId) throw new Error("Usage: muster channels setup matrix --homeserver https://matrix.example.org --user-id @muster:example.org --access-token-env MATRIX_ACCESS_TOKEN --allow-from @you:example.org");
  try { new URL(homeserverUrl); } catch { throw new Error(`--homeserver is not a URL: ${homeserverUrl}`); }
  if (!/^@[^:\s]+:\S+$/.test(userId)) throw new Error(`--user-id must look like @name:server, got ${userId}`);
  return {
    ...existing,
    homeserverUrl,
    userId,
    accessTokenEnv: envName(flag(args, "--access-token-env") ?? existing?.accessTokenEnv, "MATRIX_ACCESS_TOKEN", "--access-token-env"),
    allowFrom: list(flag(args, "--allow-from")) ?? existing?.allowFrom ?? [],
  };
}

function emailSetup(existing: GatewayEmailChannelConfig | undefined, args: readonly string[]): GatewayEmailChannelConfig {
  refuseSecretFlags(args, ["--password", "--imap-password", "--smtp-password"], "--password-env");
  const address = (flag(args, "--address") ?? existing?.address)?.toLowerCase();
  const imapHost = flag(args, "--imap-host") ?? existing?.imap.host;
  const smtpHost = flag(args, "--smtp-host") ?? existing?.smtp.host;
  if (!address || !imapHost || !smtpHost) {
    throw new Error("Usage: muster channels setup email --address bot@example.com --imap-host imap.example.com --smtp-host smtp.example.com --username bot@example.com --password-env MUSTER_EMAIL_PASSWORD --allow-from you@example.com,*@example.com");
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(address)) throw new Error(`--address is not an email address: ${address}`);
  const username = flag(args, "--username");
  const passwordEnv = flag(args, "--password-env");
  const imapSecurity = security(flag(args, "--imap-security"), existing?.imap.security ?? "tls", "--imap-security");
  const smtpSecurity = security(flag(args, "--smtp-security"), existing?.smtp.security ?? "starttls", "--smtp-security");
  return {
    ...existing,
    address,
    imap: {
      ...existing?.imap,
      host: imapHost,
      port: port(flag(args, "--imap-port"), existing?.imap.port ?? (imapSecurity === "tls" ? 993 : 143), "--imap-port"),
      security: imapSecurity,
      user: flag(args, "--imap-user") ?? username ?? existing?.imap.user ?? address,
      passwordEnv: envName(flag(args, "--imap-password-env") ?? passwordEnv ?? existing?.imap.passwordEnv, "MUSTER_EMAIL_PASSWORD", "--password-env"),
      ...(flag(args, "--mailbox") ? { mailbox: flag(args, "--mailbox") } : {}),
    },
    smtp: {
      ...existing?.smtp,
      host: smtpHost,
      port: port(flag(args, "--smtp-port"), existing?.smtp.port ?? (smtpSecurity === "tls" ? 465 : 587), "--smtp-port"),
      security: smtpSecurity,
      user: flag(args, "--smtp-user") ?? username ?? existing?.smtp.user ?? address,
      passwordEnv: envName(flag(args, "--smtp-password-env") ?? passwordEnv ?? existing?.smtp.passwordEnv, "MUSTER_EMAIL_PASSWORD", "--password-env"),
    },
    allowFrom: list(flag(args, "--allow-from")) ?? existing?.allowFrom ?? [],
  };
}

async function loadOrInit(): Promise<GatewayConfig> {
  return loadGatewayConfig().catch(async () => (await initGatewayConfig()).config);
}

function secretEnvNames(channel: string, config: GatewayConfig): string[] {
  if (channel === "matrix") return config.channels?.matrix ? [config.channels.matrix.accessTokenEnv] : [];
  const email = config.channels?.email;
  return email ? [...new Set([email.imap.passwordEnv, email.smtp.passwordEnv])] : [];
}

/** Handle `muster channels <action> matrix|email`. Returns false when the channel is not SDK-only. */
export async function sdkChannelsCommand(args: readonly string[], log: (line: string) => void = console.log): Promise<boolean> {
  const [action, channel] = args;
  if (!channel || !(SDK_ONLY_CHANNELS as readonly string[]).includes(channel)) return false;
  if (action === "setup" || action === "connect") {
    const config = await loadOrInit();
    const saved = channel === "matrix" ? matrixSetup(config.channels?.matrix, args) : emailSetup(config.channels?.email, args);
    const updated: GatewayConfig = { ...config, channels: { ...config.channels, [channel]: saved } };
    const path = await saveGatewayConfig(updated);
    log(`gateway_config=${path}`);
    log(`channel=${channel} configured=true allow_from=${saved.allowFrom?.length ? saved.allowFrom.join(",") : "-"}`);
    for (const name of secretEnvNames(channel, updated)) log(`secret=env:${name} set=${process.env[name] ? "yes" : "no"}`);
    if (!saved.allowFrom?.length) log("warning=allowFrom is empty; nobody can reach Muster until you add --allow-from");
    if (channel === "matrix") log("note=end-to-end encrypted rooms are not supported; invite the bot to an unencrypted room");
    log(`verify=muster channels doctor ${channel} --live`);
    log(`start=muster gateway start --with-${channel}`);
    return true;
  }
  if (action === "doctor") {
    const result = await runChannelDoctor(channel, { live: args.includes("--live") });
    for (const check of result.checks) log(`check=${check.id} status=${check.status} detail="${check.detail.replaceAll("\"", "'")}"`);
    log(`doctor=${channel} status=${result.status}${args.includes("--live") ? " live=true" : " live=false"}`);
    if (result.status === "fail") process.exitCode = 1;
    return true;
  }
  if (action === "status") {
    const config = await loadGatewayConfig().catch(() => undefined);
    const adapter = defaultChannelRegistry().get(channel)!;
    log(`channel=${channel} ready=${config ? adapter.configured(config) : false} transport=${channel === "matrix" ? "sync_long_poll" : "imap_idle+smtp"} start="muster gateway start --with-${channel}"`);
    return true;
  }
  if (action === "send") {
    const to = flag(args, "--to");
    const message = flag(args, "--message");
    if (!to || !message) throw new Error(`Usage: muster channels send ${channel} --to <room-or-address> --message TEXT`);
    const result = await sendToChannel(channel, to, message);
    log(`sent=${channel} to=${to} messages=${result.messageIds.length}`);
    return true;
  }
  throw new Error(`Usage: muster channels setup|doctor|status|send ${channel} [flags]`);
}
