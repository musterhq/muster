import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

/**
 * Bot Framework auth for Teams, dependency-free:
 * - inbound: the connector's RS256 JWT, checked against the JWKS named by the
 *   configured OpenID document (issuer, audience = app id, expiry, serviceUrl);
 * - outbound: a client-credentials bot token from the configured endpoint.
 * Nothing but those two configured endpoints and the JWKS they name is fetched.
 */

export const BOT_FRAMEWORK_OPENID = "https://login.botframework.com/v1/.well-known/openidconfiguration";
export const BOT_FRAMEWORK_TOKEN_URL = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
export const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";
const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";
const CLOCK_SKEW_SECONDS = 300;
const KEY_CACHE_MS = 60 * 60_000;
/** A forced refresh (unknown kid) happens at most this often per OpenID document. */
const KEY_REFRESH_MIN_MS = 5 * 60_000;

interface Jwk extends JsonWebKey {
  readonly kid?: string;
}

const keyCache = new Map<string, { readonly keys: readonly Jwk[]; readonly expiresAt: number; readonly fetchedAt: number }>();
const tokenCache = new Map<string, { readonly token: string; readonly expiresAt: number }>();

function segment<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

function sameServiceUrl(left: string, right: string): boolean {
  return left.replace(/\/+$/, "").toLowerCase() === right.replace(/\/+$/, "").toLowerCase();
}

async function signingKeys(openIdConfigUrl: string, fetcher: typeof fetch, now: number, refresh: boolean): Promise<readonly Jwk[]> {
  const cached = keyCache.get(openIdConfigUrl);
  // Keys rotate rarely: a token with an unknown kid may force one refetch per window, never one per request.
  if (cached && cached.expiresAt > now && (!refresh || now - cached.fetchedAt < KEY_REFRESH_MIN_MS)) return cached.keys;
  const config = await fetcher(openIdConfigUrl, { headers: { accept: "application/json" } });
  if (!config.ok) throw new Error(`Bot Framework OpenID configuration: HTTP ${config.status}`);
  const jwksUri = (await config.json() as { jwks_uri?: unknown }).jwks_uri;
  if (typeof jwksUri !== "string" || !jwksUri) throw new Error("Bot Framework OpenID configuration has no jwks_uri");
  const jwks = await fetcher(jwksUri, { headers: { accept: "application/json" } });
  if (!jwks.ok) throw new Error(`Bot Framework JWKS: HTTP ${jwks.status}`);
  const keys = (await jwks.json() as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) throw new Error("Bot Framework JWKS has no keys");
  keyCache.set(openIdConfigUrl, { keys: keys as Jwk[], expiresAt: now + KEY_CACHE_MS, fetchedAt: now });
  return keys as Jwk[];
}

export interface BotFrameworkTokenCheck {
  readonly authorization: string | undefined;
  readonly appId: string;
  /** The activity's serviceUrl; must match the token's serviceurl claim. */
  readonly serviceUrl?: string;
  readonly openIdConfigUrl?: string;
  readonly issuer?: string;
  readonly fetcher: typeof fetch;
  readonly now?: number;
}

/** True only for a correctly signed, unexpired token for this bot. Never throws. */
export async function verifyBotFrameworkToken(input: BotFrameworkTokenCheck): Promise<boolean> {
  try {
    const match = /^Bearer\s+([^\s]+)$/i.exec(input.authorization?.trim() ?? "");
    if (!match) return false;
    const parts = match[1].split(".");
    if (parts.length !== 3) return false;
    const header = segment<{ alg?: string; kid?: string }>(parts[0]);
    const claims = segment<{ iss?: string; aud?: string | string[]; exp?: number; nbf?: number; serviceurl?: string; serviceUrl?: string }>(parts[1]);
    if (header.alg !== "RS256" || !header.kid) return false;
    const nowMs = input.now ?? Date.now();
    const now = Math.floor(nowMs / 1000);
    if (claims.iss !== (input.issuer ?? BOT_FRAMEWORK_ISSUER)) return false;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(input.appId)) return false;
    if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_SECONDS) return false;
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + CLOCK_SKEW_SECONDS)) return false;
    // The reply (with a bot token) goes to the activity's serviceUrl, so the token must vouch for it.
    const claimedServiceUrl = claims.serviceurl ?? claims.serviceUrl;
    if (!claimedServiceUrl || !input.serviceUrl || !sameServiceUrl(claimedServiceUrl, input.serviceUrl)) return false;
    const openId = input.openIdConfigUrl ?? BOT_FRAMEWORK_OPENID;
    let key = (await signingKeys(openId, input.fetcher, nowMs, false)).find((candidate) => candidate.kid === header.kid);
    // Keys rotate: one refresh on an unknown kid.
    if (!key) key = (await signingKeys(openId, input.fetcher, nowMs, true)).find((candidate) => candidate.kid === header.kid);
    if (!key) return false;
    return verifySignature("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  } catch {
    return false;
  }
}

/** Client-credentials bot token for connector calls, cached until a minute before expiry. */
export async function botFrameworkAccessToken(input: {
  readonly appId: string;
  readonly appPassword: string;
  readonly tokenUrl?: string;
  readonly fetcher: typeof fetch;
}): Promise<string> {
  const tokenUrl = input.tokenUrl ?? BOT_FRAMEWORK_TOKEN_URL;
  const cacheKey = `${input.appId}\0${tokenUrl}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const response = await input.fetcher(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: input.appId,
      client_secret: input.appPassword,
      scope: BOT_FRAMEWORK_SCOPE,
    }).toString(),
  });
  const body = await response.json().catch(() => ({})) as { access_token?: unknown; expires_in?: unknown };
  if (!response.ok || typeof body.access_token !== "string") throw new Error(`Bot Framework token request failed: HTTP ${response.status}`);
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  tokenCache.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + expiresIn * 1000 });
  return body.access_token;
}
