import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import { KrogerApiError, NotAuthenticatedError, describeErrorBody } from "./errors.js";
import { listenForAuthCode, type CallbackListener } from "./login.js";
import type { JsonStore } from "./store.js";

export type FetchFn = typeof fetch;

export const APP_SCOPE = "product.compact";
export const USER_SCOPES = ["cart.basic:write", "profile.compact"] as const;

/** Refresh tokens this long before they actually expire. */
const EXPIRY_SKEW_MS = 60_000;
const USER_TOKENS_KEY = "tokens";

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export interface UserTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms */
  expiresAt: number;
  scope?: string;
}

export interface UserAuthStatus {
  loggedIn: boolean;
  accessTokenExpiresAt?: string;
  accessTokenValid?: boolean;
  canRefresh?: boolean;
  scope?: string;
  loginPending: boolean;
  lastLoginError?: string;
}

interface PendingLogin {
  url: string;
  listener: CallbackListener;
  done: Promise<void>;
}

/**
 * Manages both Kroger token types:
 * - an app token (client credentials) for products/locations, cached in memory;
 * - a user token (authorization code) for cart/profile, persisted to disk and refreshed.
 */
export class TokenManager {
  private appToken?: { accessToken: string; expiresAt: number };
  private appTokenInflight?: Promise<string>;
  /** `undefined` = not loaded from disk yet; `null` = loaded, none saved. */
  private userTokens?: UserTokens | null;
  private userRefreshInflight?: Promise<string>;
  private pendingLogin?: PendingLogin;
  private lastLoginError?: string;

  constructor(
    private readonly config: Config,
    private readonly store: JsonStore,
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getAppToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.appToken && this.isFresh(this.appToken.expiresAt)) {
      return this.appToken.accessToken;
    }
    this.appTokenInflight ??= this.requestToken({ grant_type: "client_credentials", scope: APP_SCOPE })
      .then((t) => {
        this.appToken = { accessToken: t.access_token, expiresAt: this.now() + t.expires_in * 1000 };
        return t.access_token;
      })
      .finally(() => {
        this.appTokenInflight = undefined;
      });
    return this.appTokenInflight;
  }

  async getUserToken(forceRefresh = false): Promise<string> {
    const tokens = await this.loadUserTokens();
    if (!tokens) throw new NotAuthenticatedError();
    if (!forceRefresh && this.isFresh(tokens.expiresAt)) return tokens.accessToken;
    if (!tokens.refreshToken) {
      throw new NotAuthenticatedError("Kroger login has expired.");
    }
    this.userRefreshInflight ??= this.refreshUserToken(tokens.refreshToken).finally(() => {
      this.userRefreshInflight = undefined;
    });
    return this.userRefreshInflight;
  }

  async userStatus(): Promise<UserAuthStatus> {
    const tokens = await this.loadUserTokens();
    return {
      loggedIn: !!tokens,
      ...(tokens && {
        accessTokenExpiresAt: new Date(tokens.expiresAt).toISOString(),
        accessTokenValid: this.isFresh(tokens.expiresAt),
        canRefresh: !!tokens.refreshToken,
        scope: tokens.scope,
      }),
      loginPending: !!this.pendingLogin,
      ...(this.lastLoginError && { lastLoginError: this.lastLoginError }),
    };
  }

  authorizeUrl(state: string): string {
    const url = new URL(`${this.config.apiBase}/connect/oauth2/authorize`);
    url.search = new URLSearchParams({
      scope: USER_SCOPES.join(" "),
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      state,
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string): Promise<void> {
    let t: TokenResponse;
    try {
      t = await this.requestToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.config.redirectUri,
      });
    } catch (err) {
      if (err instanceof KrogerApiError && /redirect_uri/i.test(err.message)) {
        err.message +=
          ` — register ${this.config.redirectUri} as a redirect URI on your app at developer.kroger.com, ` +
          "or set KROGER_REDIRECT_URI to one that is registered.";
      }
      throw err;
    }
    await this.saveUserTokens(this.toUserTokens(t));
  }

  /**
   * Begin the browser login flow. Returns the URL the user must open; `done`
   * settles once the redirect is received and tokens are saved. Calling again
   * while a login is pending returns the same URL.
   */
  async startLogin(timeoutMs = 10 * 60_000): Promise<{ url: string; done: Promise<void> }> {
    if (this.pendingLogin) return { url: this.pendingLogin.url, done: this.pendingLogin.done };

    const state = randomBytes(16).toString("hex");
    const listener = await listenForAuthCode(this.config.redirectUri, state, timeoutMs, (code) =>
      this.exchangeCode(code),
    );
    const url = this.authorizeUrl(state);
    this.lastLoginError = undefined;
    const done = listener.done
      .catch((err: unknown) => {
        this.lastLoginError = err instanceof Error ? err.message : String(err);
        throw err;
      })
      .finally(() => {
        this.pendingLogin = undefined;
      });
    // The MCP tool doesn't await `done`; failures are reported via userStatus().
    done.catch(() => {});
    this.pendingLogin = { url, listener, done };
    return { url, done };
  }

  async logout(): Promise<void> {
    this.pendingLogin?.listener.close();
    await this.clearUserTokens();
  }

  private async refreshUserToken(refreshToken: string): Promise<string> {
    let t: TokenResponse;
    try {
      t = await this.requestToken({ grant_type: "refresh_token", refresh_token: refreshToken });
    } catch (err) {
      // A rejected refresh token means the user must log in again; transient errors propagate as-is.
      if (err instanceof KrogerApiError && (err.status === 400 || err.status === 401)) {
        await this.clearUserTokens();
        throw new NotAuthenticatedError("Kroger login has expired.");
      }
      throw err;
    }
    // Kroger may or may not rotate the refresh token; keep the old one if none is returned.
    const tokens = this.toUserTokens(t, refreshToken);
    await this.saveUserTokens(tokens);
    return tokens.accessToken;
  }

  private toUserTokens(t: TokenResponse, previousRefreshToken?: string): UserTokens {
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? previousRefreshToken,
      expiresAt: this.now() + t.expires_in * 1000,
      scope: t.scope,
    };
  }

  private async loadUserTokens(): Promise<UserTokens | null> {
    if (this.userTokens === undefined) {
      this.userTokens = (await this.store.read<UserTokens>(USER_TOKENS_KEY)) ?? null;
    }
    return this.userTokens;
  }

  private async saveUserTokens(tokens: UserTokens): Promise<void> {
    this.userTokens = tokens;
    await this.store.write(USER_TOKENS_KEY, tokens);
  }

  private async clearUserTokens(): Promise<void> {
    this.userTokens = null;
    await this.store.delete(USER_TOKENS_KEY);
  }

  private isFresh(expiresAt: number): boolean {
    return expiresAt - EXPIRY_SKEW_MS > this.now();
  }

  private async requestToken(params: Record<string, string>): Promise<TokenResponse> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const res = await this.fetchFn(`${this.config.apiBase}/connect/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(params).toString(),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // leave as text
    }
    if (!res.ok) {
      const detail = describeErrorBody(body) ?? res.statusText;
      throw new KrogerApiError(
        res.status,
        `Kroger token request (${params.grant_type}) failed with ${res.status}: ${detail}`,
        body,
      );
    }
    return body as TokenResponse;
  }
}
