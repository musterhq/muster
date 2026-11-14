import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CallsConfig, SmsConfig } from "@musterhq/core";
import type { FrappeOAuthConnectionConfig } from "./frappe-oauth.js";

/** Gateway-local config (.muster/gateway.json): bearer token + adapter bot tokens. */
export interface GatewayCustomCommand {
  /** Reader-facing summary shown in future command listings. */
  readonly description?: string;
  /** Prompt template; "{args}" or "{{args}}" is replaced with command args. */
  readonly prompt?: string;
  /** Exact surface id ("web:demo") or surface prefix ("telegram") allowed to use this command. */
  readonly surfaces?: readonly string[];
  readonly source?: "openclaw" | "user" | "migration";
  readonly sourceChannel?: string;
}

/**
 * Human-facing identity for a Frappe-connected deployment. This is policy and
 * copy only; it never carries credentials or expands a user's Frappe access.
 */
export interface GatewayFrappeAssistantConfig {
  readonly name?: string;
  readonly description?: string;
  readonly organization?: string;
  readonly domains?: readonly string[];
  /** Deployment-owned scope rules used to resolve ambiguous business requests. */
  readonly operatingInstructions?: readonly string[];
}

/**
 * Deployment-owned support destination. OAuth remains the default. A public
 * intake endpoint must be opted into explicitly for one exact origin and
 * record type; this object never contains credentials.
 */
export interface GatewayFrappeSupportConfig {
  /** Canonical HTTPS origin of the support site. */
  readonly site?: string;
  /** OAuth connection id configured under frappe.oauth.connections. */
  readonly connectionId?: string;
  /** Authentication contract for ticket creation. Defaults to actor-bound OAuth. */
  readonly authMode?: "oauth" | "guest";
  /** Support record type exposed by the destination site. */
  readonly doctype?: "HD Ticket" | "Issue";
  /** Optional deployment default, still validated by the live destination. */
  readonly priority?: string;
  /** Optional Helpdesk customer mapped by the deployment, never inferred from a sender. */
  readonly customer?: string;
}

export interface GatewayFrappeTelegramTenant {
  readonly id: string;
  /** Exact trusted Frappe origin for this tenant. */
  readonly site: string;
  /** Maximum scopes this tenant may place in a Telegram identity link. */
  readonly allowedScopes: readonly string[];
}

export interface GatewayFrappeTelegramLinkingConfig {
  readonly enabled: true;
  /** Telegram bot username without @, used only to construct the Frappe deep link. */
  readonly botUsername: string;
  /** Explicit site registry; no browser-supplied hostname can create a tenant. */
  readonly tenants: readonly GatewayFrappeTelegramTenant[];
}

export interface GatewayConfig {
  readonly token: string;
  readonly port?: number;
  readonly security?: {
    readonly deployment?: "development" | "production";
    readonly allowLegacyGchatToken?: boolean;
  };
  readonly governance?: GatewayGovernanceConfig;
  readonly approvals?: {
    /** Lifetime of channel approval buttons. Defaults to 10 minutes. */
    readonly ttlSeconds?: number;
  };
  readonly commands?: {
    readonly entries?: Record<string, GatewayCustomCommand>;
  };
  readonly frappe?: {
    /** Canonical externally reachable Muster origin used for reciprocal site bindings. */
    readonly publicOrigin?: string;
    /** Stable non-secret identifier for this Muster installation. */
    readonly installationId?: string;
    readonly assistant?: GatewayFrappeAssistantConfig;
    /** Evidence-rich issue reporting destination. */
    readonly support?: GatewayFrappeSupportConfig;
    /** Reviewed, read-only business API contracts available to the Frappe capability pack. */
    readonly businessApis?: readonly Record<string, unknown>[];
    /** Optional permission-scoped read-model location; defaults inside .muster/data. */
    readonly readModelPath?: string;
    /** Gateway-held HMAC key for actor-bound, single-use Frappe write approvals. */
    readonly approvalSigningKey?: string;
    /** Duplicate provider-native business connectors to suppress for OAuth-bound Frappe turns. */
    readonly providerTools?: { readonly denyInherited?: readonly string[] };
    /** Real isolated Desk automation. Disabled unless explicitly enabled. */
    readonly browserAutomation?: {
      readonly enabled: true;
      /** Headless is the production default; set false for an attended evidence run. */
      readonly headless?: boolean;
      /** Operator-owned Chromium executable path; never accepted from a workflow. */
      readonly executablePath?: string;
      readonly launchTimeoutMs?: number;
      readonly actionTimeoutMs?: number;
      readonly maxActionsPerNode?: number;
    };
    readonly telegramLinking?: GatewayFrappeTelegramLinkingConfig;
    readonly oauth?: {
      readonly defaultConnection?: string;
      readonly connections: readonly FrappeOAuthConnectionConfig[];
    };
  };
  readonly telegram?: {
    /** Friendly bot label shown in setup/status output; not used as a secret. */
    readonly name?: string;
    /** Inline bot token. Prefer botTokenEnv; when both are set, the env var wins and the inline value is never saved. */
    readonly botToken?: string;
    /** Name of the environment variable holding the bot token. */
    readonly botTokenEnv?: string;
    /** "draft" streams replies as live-edited drafts (sendMessage + editMessageText). */
    readonly stream?: "off" | "draft";
    /** Native presence/progress behavior while a run is active. */
    readonly status?: "off" | "typing";
    /** High-level progress messages. Never exposes provider chain-of-thought. */
    readonly thinking?: "off" | "progress";
    /** Handling for a second message while the same chat already has a run. */
    readonly busy?: "queue" | "reject";
    /**
     * Optional webhook secret. When set, Telegram echoes it in the
     * X-Telegram-Bot-Api-Secret-Token header; the gateway rejects any webhook
     * whose header does not match (constant-time). Configure it via setWebhook.
     */
    readonly secretToken?: string;
  };
  readonly slack?: {
    readonly botToken: string;
    /** Slack Socket Mode app-level token (`xapp-...`). Avoids public HTTPS webhook setup. */
    readonly appToken?: string;
    /** Socket Mode is the local/private default; HTTP Events API stays available for public webhook deployments. */
    readonly mode?: "socket" | "http";
    /** "draft" streams replies as live-edited drafts (chat.postMessage + chat.update). */
    readonly stream?: "off" | "draft";
    /** Slack has no bot typing API; "message" posts/updates one progress note. */
    readonly status?: "off" | "message";
    /** High-level progress messages. Never exposes provider chain-of-thought. */
    readonly thinking?: "off" | "progress";
    /** Handling for a second message while the same Slack thread already has a run. */
    readonly busy?: "queue" | "reject";
    /**
     * Slack app "Signing Secret". When set, every webhook is verified against
     * the X-Slack-Signature / X-Slack-Request-Timestamp headers (v0 HMAC-SHA256)
     * before parsing, and stale requests (>5 min) are rejected as replays.
     */
    readonly signingSecret?: string;
  };
  readonly discord?: {
    /** Legacy inline bot token. Prefer botTokenEnv. */
    readonly botToken?: string;
    /** Name of the environment variable holding the bot token. */
    readonly botTokenEnv?: string;
    /** Application public key (hex, developer portal) for ed25519 interaction verification. */
    readonly publicKey?: string;
    /** REST base; defaults to https://discord.com/api/v10. */
    readonly apiBaseUrl?: string;
    /** Gateway WebSocket URL; defaults to the one GET /gateway/bot returns. */
    readonly gatewayUrl?: string;
  };
  readonly whatsapp?: {
    readonly account?: string;
    readonly activation?: "mention" | "always";
    /** Empty blocks all groups; "*" admits every group. */
    readonly groups?: readonly string[];
    /** Empty admits every member after the group allowlist passes. */
    readonly groupAllowFrom?: readonly string[];
    readonly sessionDir?: string;
  };
  readonly "whatsapp-cloud"?: {
    /** Legacy inline access token. Prefer accessTokenEnv. */
    readonly accessToken?: string;
    /** Name of the environment variable holding the Graph API access token. */
    readonly accessTokenEnv?: string;
    readonly verifyToken: string;
    readonly phoneNumberId: string;
    /** Meta app secret for X-Hub-Signature-256 POST webhook verification. */
    readonly appSecret?: string;
    /** Graph API version segment; defaults to v19.0. */
    readonly apiVersion?: string;
  };
  readonly gchat?: {
    /** Legacy payload token retained for existing installations. */
    readonly verificationToken?: string;
    /** Modern bearer verification is performed by an injected verifier. */
    readonly verification?: { readonly mode: "bearer"; readonly audience: string };
    /**
     * Answer through the Chat API (in-thread, asynchronously) instead of the
     * synchronous webhook response. The service-account key JSON is read from
     * the named environment variable; it is never stored here.
     */
    readonly api?: {
      readonly serviceAccountKeyEnv: string;
      /** Chat API base; defaults to https://chat.googleapis.com/v1. */
      readonly baseUrl?: string;
      /** OAuth token endpoint; defaults to the key's token_uri. */
      readonly tokenUrl?: string;
    };
    /** Google command id -> Muster slash command. */
    readonly commands?: Readonly<Record<string, string>>;
    /** Resolve a verified Google email to a permission-bearing Frappe identity. */
    readonly frappeIdentity?: {
      /** Full HTTPS Frappe method URL for the identity resolver. */
      readonly resolverUrl: string;
      /** Environment variable containing an OAuth access token for Frappe. */
      readonly oauthTokenEnv: string;
      /** Defense-in-depth domain allowlist; an empty list denies every automatic binding. */
      readonly allowedDomains: readonly string[];
      readonly timeoutMs?: number;
      /** Revalidate Frappe role/employee binding after this interval. Defaults to 60 seconds. */
      readonly cacheTtlMs?: number;
    };
  };
  readonly teams?: {
    /** Outgoing-webhook mode: base64 HMAC secret. */
    readonly hmacSecret?: string;
    /** Bot Framework mode: the bot's Microsoft app id (the JWT audience). */
    readonly appId?: string;
    /** Name of the environment variable holding the bot's app password (client secret). */
    readonly appPasswordEnv?: string;
    /** Bot Framework OpenID configuration; defaults to https://login.botframework.com/v1/.well-known/openidconfiguration */
    readonly openIdConfigUrl?: string;
    /** Bot token endpoint; defaults to https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token */
    readonly tokenUrl?: string;
    /** Expected JWT issuer; defaults to https://api.botframework.com */
    readonly issuer?: string;
  };
  /** Channels built on the channel SDK (channel-sdk.ts). Secrets are env-var names, never values. */
  readonly channels?: GatewayChannelsConfig;
  /** Governed outbound phone calls (docs/spec/clauses/25-calls-sms.md). Secrets are env-var names. */
  readonly calls?: CallsConfig;
  /** SMS on the channel SDK, through the calls provider. */
  readonly sms?: SmsConfig;
  readonly devices?: {
    readonly entries?: Record<string, GatewayDeviceRecord>;
  };
}

/** Settings every SDK channel shares. The shared ingest path enforces them. */
export interface GatewayChannelCommonConfig {
  /**
   * Senders admitted to the pairing step. Exact ids, "*" for everyone, or a
   * "*suffix" wildcard such as "*@example.com". Missing or empty admits nobody.
   */
  readonly allowFrom?: readonly string[];
}

export interface GatewayMatrixChannelConfig extends GatewayChannelCommonConfig {
  /** Client-server API base, e.g. https://matrix.example.org */
  readonly homeserverUrl: string;
  /** The bot account, e.g. @muster:example.org */
  readonly userId: string;
  /** Name of the environment variable holding the access token. */
  readonly accessTokenEnv: string;
  /** Join rooms when an allowed sender invites the bot. Defaults to true. */
  readonly autoJoin?: boolean;
  /** /sync long-poll timeout. Defaults to 30 000 ms. */
  readonly syncTimeoutMs?: number;
}

export interface GatewayMailServerConfig {
  readonly host: string;
  readonly port: number;
  /** "tls" = implicit TLS, "starttls" = upgrade after connect, "none" = plaintext (local testing only). */
  readonly security: "tls" | "starttls" | "none";
  readonly user: string;
  /** Name of the environment variable holding the password or app password. */
  readonly passwordEnv: string;
}

export interface GatewayEmailChannelConfig extends GatewayChannelCommonConfig {
  /** The address Muster reads and answers as. */
  readonly address: string;
  readonly displayName?: string;
  readonly imap: GatewayMailServerConfig & { readonly mailbox?: string };
  readonly smtp: GatewayMailServerConfig;
  /** Poll interval when IMAP IDLE is unavailable. Defaults to 60 000 ms. */
  readonly pollIntervalMs?: number;
  /** Maximum time one IMAP IDLE waits before re-checking. Defaults to 25 minutes. */
  readonly idleTimeoutMs?: number;
}

export interface GatewayChannelsConfig {
  readonly matrix?: GatewayMatrixChannelConfig;
  readonly email?: GatewayEmailChannelConfig;
  readonly [channelId: string]: GatewayChannelCommonConfig | undefined;
}

export interface GatewayDeviceRecord {
  readonly source?: "openclaw" | "migration" | "user";
  readonly sourceId?: string;
  readonly surfaceId?: string;
  readonly accountId?: string;
  readonly scopes?: readonly string[];
  readonly approved?: boolean;
  readonly migratedAt?: string;
}

export type GatewayGovernanceSubjectKind =
  | "user"
  | "role"
  | "department"
  | "channel"
  | "surface"
  | "tenant"
  | "workspace"
  | "agent";
export type GatewayGovernanceRateWindow = "minute" | "hour" | "day" | "month";

export interface GatewayGovernanceSubject {
  readonly kind: GatewayGovernanceSubjectKind;
  readonly id: string;
}

export interface GatewayGovernanceAssignment {
  /** Friendly user id used in reports; defaults to the surface sender id. */
  readonly userId?: string;
  readonly roles?: readonly string[];
  /** Department memberships attached to this user for scoped usage and reporting. */
  readonly departmentIds?: readonly string[];
  readonly tenantId?: string;
  readonly workspaceId?: string;
  readonly allowedSurfaces?: readonly string[];
  readonly allowedChannels?: readonly string[];
  /** Optional command-capability allowlist used by menus and actions. */
  readonly capabilities?: readonly string[];
  /** Explicit reporting hierarchy. Manager roles alone never grant access to other users' usage. */
  readonly managedUserIds?: readonly string[];
  readonly managedDepartmentIds?: readonly string[];
  /** Tenant-wide reporting is opt-in even for system roles. */
  readonly canViewTenantUsage?: boolean;
  /** Identified user rows are opt-in; the default manager view is pseudonymous. */
  readonly canViewIdentifiedUsage?: boolean;
}

export interface GatewayGovernanceValidationConfig {
  readonly maxChars?: number;
  readonly blockSecrets?: boolean;
  readonly blockedPatterns?: readonly string[];
}

export interface GatewayGovernanceRateLimit {
  readonly subject: GatewayGovernanceSubject;
  readonly window: GatewayGovernanceRateWindow;
  readonly maxRuns?: number;
  readonly maxTokens?: number;
}

export interface GatewayGovernanceConfig {
  readonly enabled?: boolean;
  /**
   * Assignments are keyed by the most specific available identity:
   *   - "<surfaceId>:<senderId>"
   *   - "<senderId>"
   *   - "default"
   */
  readonly assignments?: Record<string, GatewayGovernanceAssignment>;
  readonly requestValidation?: GatewayGovernanceValidationConfig;
  readonly rateLimits?: readonly GatewayGovernanceRateLimit[];
  /** Conservative output estimate for pre-run token/rate checks; defaults to 800. */
  readonly estimatedOutputTokens?: number;
}

export const DEFAULT_GATEWAY_PORT = 7460;

/**
 * Google Chat supports either the exact HTTPS interaction endpoint or a Google
 * Cloud project number as the signed bearer audience. URL audiences must point
 * at Muster's Google Chat ingress route so a typo cannot look production-ready.
 */
export function googleChatAudienceIsValid(value: string | undefined): boolean {
  const audience = value?.trim();
  if (!audience) return false;
  if (/^[1-9]\d{5,29}$/.test(audience)) return true;
  try {
    const url = new URL(audience);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname === "/v1/adapters/gchat";
  } catch {
    return false;
  }
}

export function gatewayConfigPath(cwd = process.cwd()): string {
  return join(cwd, ".muster", "gateway.json");
}

/** Create .muster/gateway.json with a fresh bearer token; reuse if present. */
export async function initGatewayConfig(cwd = process.cwd()): Promise<{ path: string; config: GatewayConfig; created: boolean }> {
  const path = gatewayConfigPath(cwd);
  try {
    const existing = await loadGatewayConfig(cwd);
    return { path, config: existing, created: false };
  } catch {
    const config: GatewayConfig = { token: randomBytes(24).toString("hex"), port: DEFAULT_GATEWAY_PORT };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700).catch(() => undefined);
    await writeJsonAtomic(path, config);
    return { path, config, created: true };
  }
}

export async function loadGatewayConfig(cwd = process.cwd()): Promise<GatewayConfig> {
  const raw = await readFile(gatewayConfigPath(cwd), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error("Gateway not initialized. Run: muster gateway init");
    }
    throw error;
  });
  const parsed = JSON.parse(raw) as Partial<GatewayConfig>;
  if (typeof parsed.token !== "string" || !parsed.token.trim()) {
    throw new Error(`Gateway config at ${gatewayConfigPath(cwd)} is missing a "token". Re-run: muster gateway init`);
  }
  return resolveGatewayEnvRefs(parsed as GatewayConfig);
}

/**
 * Fill in tokens that gateway.json names by env var (`telegram.botTokenEnv`),
 * so the adapters read one field. The value lives only in memory: saving
 * strips it again (see `stripGatewayEnvRefs`).
 */
export function resolveGatewayEnvRefs(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const telegram = config.telegram;
  if (!telegram?.botTokenEnv) return config;
  const value = env[telegram.botTokenEnv];
  return { ...config, telegram: { ...telegram, botToken: value || undefined } };
}

function stripGatewayEnvRefs(config: GatewayConfig): GatewayConfig {
  const telegram = config.telegram;
  if (!telegram?.botTokenEnv || telegram.botToken === undefined) return config;
  const { botToken: _inline, ...rest } = telegram;
  return { ...config, telegram: rest };
}

export async function saveGatewayConfig(config: GatewayConfig, cwd = process.cwd()): Promise<string> {
  const path = gatewayConfigPath(cwd);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  await writeJsonAtomic(path, stripGatewayEnvRefs(config));
  return path;
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, target);
  await chmod(target, 0o600).catch(() => undefined);
}
