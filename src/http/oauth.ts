import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";
import type { TokenManager } from "../auth.js";
import type { KrogerClient } from "../client.js";
import type { HttpConfig } from "../config.js";
import { NotAuthenticatedError } from "../errors.js";
import type { JsonStore } from "../store.js";
import { renderPage } from "./pages.js";

const ACCESS_TOKEN_TTL_MS = 60 * 60_000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60_000; // 90 days, sliding (rotated on each use)
const AUTH_CODE_TTL_MS = 5 * 60_000;
const KROGER_LOGIN_TTL_MS = 10 * 60_000;
const CONSENT_TTL_MS = 10 * 60_000;
const MAX_CLIENTS = 50;

const CLIENTS_KEY = "oauth-clients";
const TOKENS_KEY = "oauth-tokens";
const OWNER_KEY = "owner";

interface StoredToken {
  kind: "access" | "refresh";
  clientId: string;
  scopes: string[];
  /** Epoch ms */
  expiresAt: number;
  resource?: string;
}

/** Why a Kroger login was started: to authorize an MCP client, or just to reconnect the cart login. */
type KrogerLoginPurpose = { kind: "authorize"; clientId: string; params: AuthorizationParams } | { kind: "reconnect" };

/** A Kroger login in flight, keyed by the `state` we sent to Kroger. */
type PendingKrogerLogin = KrogerLoginPurpose & { expiresAt: number };

/** An authorization request waiting for the owner to approve the client on the consent page. */
interface PendingConsent {
  clientId: string;
  params: AuthorizationParams;
  /** Must come back in a cookie, binding approval to the browser that saw the consent page. */
  nonce: string;
  expiresAt: number;
}

interface IssuedCode {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

/** What the /kroger/callback route should send back to the browser. */
export type CallbackOutcome = { redirect: string } | { status: number; message: string };

export const CONSENT_PATH = "/oauth/consent";
export const consentCookieName = (id: string) => `kmcp_consent_${id}`;

/** Dynamically registered MCP clients (claude.ai, Claude Code, ...), persisted across restarts. */
class PersistentClientsStore implements OAuthRegisteredClientsStore {
  private clients?: Record<string, OAuthClientInformationFull>;

  constructor(private readonly store: JsonStore) {}

  async getClient(clientId: string) {
    return (await this.load())[clientId];
  }

  async registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) {
    // The SDK's registration handler fills in client_id before calling us.
    const full = client as OAuthClientInformationFull;
    const clients = await this.load();
    clients[full.client_id] = full;
    // Registration is open by design (OAuth DCR), so cap how many we keep; drop the oldest.
    const ids = Object.keys(clients);
    if (ids.length > MAX_CLIENTS) {
      ids
        .sort((a, b) => (clients[a].client_id_issued_at ?? 0) - (clients[b].client_id_issued_at ?? 0))
        .slice(0, ids.length - MAX_CLIENTS)
        .forEach((id) => delete clients[id]);
    }
    await this.store.write(CLIENTS_KEY, clients);
    return full;
  }

  private async load() {
    this.clients ??= (await this.store.read<Record<string, OAuthClientInformationFull>>(CLIENTS_KEY)) ?? {};
    return this.clients;
  }
}

/**
 * OAuth 2.1 authorization server for remote MCP clients that delegates the
 * actual sign-in to Kroger: /authorize sends the user to Kroger's login, and
 * only the owner's Kroger account is allowed to finish. A successful sign-in
 * also refreshes the server's saved Kroger login used by the cart tools.
 */
export class KrogerOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: PersistentClientsStore;
  private readonly pendingConsents = new Map<string, PendingConsent>();
  private readonly pendingLogins = new Map<string, PendingKrogerLogin>();
  private readonly codes = new Map<string, IssuedCode>();
  private tokens?: Record<string, StoredToken>;
  private ownerId?: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly http: HttpConfig,
    private readonly store: JsonStore,
    private readonly krogerTokens: TokenManager,
    private readonly kroger: KrogerClient,
    private readonly now: () => number = Date.now,
  ) {
    this.clientsStore = new PersistentClientsStore(store);
  }

  // --- Authorization: consent page, then hand the user to Kroger -----------------------------

  /**
   * Show a consent page naming the client and where it redirects. Client
   * registration is open, so without this an attacker could register a client
   * and trick the owner into a Kroger sign-in that hands the attacker a token.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !sameResource(params.resource, this.http.mcpUrl)) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.http.mcpUrl.href}`);
    }
    this.prune(this.pendingConsents);
    const id = randomBytes(16).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    this.pendingConsents.set(id, { clientId: client.client_id, params, nonce, expiresAt: this.now() + CONSENT_TTL_MS });

    res.cookie(consentCookieName(id), nonce, {
      httpOnly: true,
      secure: this.http.publicUrl.protocol === "https:",
      sameSite: "lax",
      path: CONSENT_PATH,
      maxAge: CONSENT_TTL_MS,
    });
    res.set({ "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" });
    const name = client.client_name || "An unnamed app";
    const redirectHost = new URL(params.redirectUri).host;
    res.status(200).type("html").send(
      renderPage(
        "Connect to Kroger MCP?",
        `<p><strong>${escapeHtml(name)}</strong> wants access to your Kroger MCP server: searching products ` +
          `and stores, and <strong>adding items to your Kroger cart</strong>.</p>` +
          `<p>After approval it will be sent back to <code>${escapeHtml(redirectHost)}</code>. ` +
          `Only approve if you just started connecting this app yourself.</p>` +
          `<form method="post" action="${CONSENT_PATH}">` +
          `<input type="hidden" name="request" value="${id}">` +
          `<button name="action" value="approve">Approve and sign in with Kroger</button> ` +
          `<button name="action" value="deny">Deny</button></form>`,
      ),
    );
  }

  /** Handle the consent form POST. `cookies` are the request's parsed cookies. */
  handleConsent(body: Record<string, unknown>, cookies: Record<string, string>): CallbackOutcome {
    const id = typeof body.request === "string" ? body.request : "";
    const pending = this.pendingConsents.get(id);
    const cookie = cookies[consentCookieName(id)];
    if (!pending || pending.expiresAt < this.now() || !cookie || !safeEqual(cookie, pending.nonce)) {
      return { status: 400, message: "This approval request has expired or is invalid. Start connecting again from your app." };
    }
    this.pendingConsents.delete(id);
    if (body.action !== "approve") {
      return { redirect: errorRedirect(pending.params, "access_denied", "The owner denied access.") };
    }
    return { redirect: this.beginKrogerLogin({ kind: "authorize", clientId: pending.clientId, params: pending.params }) };
  }

  /** Start a Kroger login that only refreshes the saved cart login (used by the kroger_login tool). */
  beginReconnect(): string {
    return this.beginKrogerLogin({ kind: "reconnect" });
  }

  private beginKrogerLogin(purpose: KrogerLoginPurpose): string {
    this.prune(this.pendingLogins);
    const state = randomBytes(24).toString("base64url");
    this.pendingLogins.set(state, { ...purpose, expiresAt: this.now() + KROGER_LOGIN_TTL_MS });
    return this.krogerTokens.authorizeUrl(state);
  }

  /** Handle Kroger's redirect back to /kroger/callback. */
  async handleKrogerCallback(query: Record<string, unknown>): Promise<CallbackOutcome> {
    const state = typeof query.state === "string" ? query.state : "";
    const pending = this.pendingLogins.get(state);
    if (!pending || pending.expiresAt < this.now()) {
      return { status: 400, message: "This login link has expired or was already used. Start again from your app." };
    }
    this.pendingLogins.delete(state);

    const fail = (status: number, message: string, oauthError = "access_denied"): CallbackOutcome =>
      pending.kind === "authorize"
        ? { redirect: errorRedirect(pending.params, oauthError, message) }
        : { status, message };

    if (typeof query.error === "string") {
      const description = typeof query.error_description === "string" ? query.error_description : query.error;
      return fail(400, `Kroger login failed: ${description}`);
    }
    if (typeof query.code !== "string" || !query.code) return fail(400, "Kroger did not return a code.", "server_error");

    // Identify the account BEFORE saving anything, so a stranger can't replace the owner's login.
    let krogerLogin, profileId: string;
    try {
      krogerLogin = await this.krogerTokens.exchangeCodeForTokens(query.code);
      profileId = (await this.kroger.getProfile(krogerLogin.accessToken)).data.id;
    } catch (err) {
      console.error("Kroger login failed:", err);
      return fail(502, `Could not complete the Kroger login: ${(err as Error).message}`, "server_error");
    }

    const owner = await this.resolveOwner();
    if (!owner) {
      // Deliberately not redirecting: the server operator needs to see this page.
      return {
        status: 403,
        message:
          "This server has no owner configured yet, so no one can sign in. If this is your server, set " +
          `KROGER_ALLOWED_PROFILE_ID=${profileId} and restart it, then try again.`,
      };
    }
    if (profileId !== owner) {
      console.error(`Rejected Kroger login from non-owner profile ${profileId}`);
      return fail(403, "This server only accepts its owner's Kroger account.");
    }

    await this.krogerTokens.saveUserTokens(krogerLogin);
    if (pending.kind === "reconnect") {
      return { status: 200, message: "Kroger account connected. You can close this window and return to your assistant." };
    }

    this.prune(this.codes);
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, { clientId: pending.clientId, params: pending.params, expiresAt: this.now() + AUTH_CODE_TTL_MS });
    const target = new URL(pending.params.redirectUri);
    target.searchParams.set("code", code);
    if (pending.params.state !== undefined) target.searchParams.set("state", pending.params.state);
    return { redirect: target.href };
  }

  /**
   * The Kroger profile allowed to sign in: KROGER_ALLOWED_PROFILE_ID, else one
   * recorded earlier, else whoever the existing saved login (e.g. from
   * `kroger-mcp auth`) belongs to.
   */
  private async resolveOwner(): Promise<string | undefined> {
    if (this.http.allowedProfileId) return this.http.allowedProfileId;
    if (this.ownerId) return this.ownerId;
    const saved = await this.store.read<{ profileId: string }>(OWNER_KEY);
    if (saved?.profileId) return (this.ownerId = saved.profileId);
    try {
      const profileId = (await this.kroger.getProfile()).data.id;
      await this.store.write(OWNER_KEY, { profileId });
      return (this.ownerId = profileId);
    } catch (err) {
      if (err instanceof NotAuthenticatedError) return undefined;
      throw err;
    }
  }

  // --- Token endpoint --------------------------------------------------------------------------

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.lookupCode(client, code).params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const issued = this.lookupCode(client, code);
    this.codes.delete(code);
    if (redirectUri !== undefined && redirectUri !== issued.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    return this.issueTokens(client.client_id, issued.params.scopes ?? [], issued.params.resource?.href);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const tokens = await this.loadTokens();
    const hash = hashToken(refreshToken);
    const stored = tokens[hash];
    if (!stored || stored.kind !== "refresh" || stored.clientId !== client.client_id || stored.expiresAt < this.now()) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    delete tokens[hash]; // rotate
    return this.issueTokens(client.client_id, stored.scopes, stored.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.http.apiKey && safeEqual(token, this.http.apiKey)) {
      // Static keys don't expire, but the bearer middleware requires an expiry.
      return { token, clientId: "api-key", scopes: [], expiresAt: Math.floor(this.now() / 1000) + 3600 };
    }
    const stored = (await this.loadTokens())[hashToken(token)];
    if (!stored || stored.kind !== "access" || stored.expiresAt < this.now()) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: Math.floor(stored.expiresAt / 1000),
      resource: stored.resource ? new URL(stored.resource) : undefined,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const tokens = await this.loadTokens();
    const hash = hashToken(request.token);
    if (tokens[hash]?.clientId === client.client_id) {
      delete tokens[hash];
      await this.saveTokens();
    }
  }

  private lookupCode(client: OAuthClientInformationFull, code: string): IssuedCode {
    const issued = this.codes.get(code);
    if (!issued || issued.expiresAt < this.now() || issued.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return issued;
  }

  private async issueTokens(clientId: string, scopes: string[], resource?: string): Promise<OAuthTokens> {
    const tokens = await this.loadTokens();
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    const now = this.now();
    // Only hashes are stored, so a leaked data file doesn't expose usable tokens.
    tokens[hashToken(accessToken)] = { kind: "access", clientId, scopes, resource, expiresAt: now + ACCESS_TOKEN_TTL_MS };
    tokens[hashToken(refreshToken)] = { kind: "refresh", clientId, scopes, resource, expiresAt: now + REFRESH_TOKEN_TTL_MS };
    await this.saveTokens();
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: refreshToken,
      ...(scopes.length && { scope: scopes.join(" ") }),
    };
  }

  private async loadTokens() {
    this.tokens ??= (await this.store.read<Record<string, StoredToken>>(TOKENS_KEY)) ?? {};
    return this.tokens;
  }

  private saveTokens(): Promise<void> {
    const tokens = this.tokens ?? {};
    for (const [hash, t] of Object.entries(tokens)) if (t.expiresAt < this.now()) delete tokens[hash];
    // Serialize writes so concurrent token requests can't interleave file writes.
    this.writeChain = this.writeChain.catch(() => {}).then(() => this.store.write(TOKENS_KEY, tokens));
    return this.writeChain;
  }

  private prune(map: Map<string, { expiresAt: number }>) {
    for (const [key, value] of map) if (value.expiresAt < this.now()) map.delete(key);
  }
}

function errorRedirect(params: AuthorizationParams, error: string, description: string): string {
  const url = new URL(params.redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (params.state !== undefined) url.searchParams.set("state", params.state);
  return url.href;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Resource indicators match ignoring a trailing slash and fragment (as the SDK's bearer check does). */
function sameResource(a: URL, b: URL): boolean {
  const norm = (u: URL) => u.href.split("#")[0].replace(/\/$/, "");
  return norm(a) === norm(b);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
