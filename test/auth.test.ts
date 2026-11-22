import { describe, expect, it } from "vitest";
import { TokenManager } from "../src/auth.js";
import { NotAuthenticatedError } from "../src/errors.js";
import { JsonStore } from "../src/store.js";
import { jsonResponse, mockFetch, testConfig, tokenResponse } from "./helpers.js";

function setup(routes: Parameters<typeof mockFetch>[0], now = { t: 1_000_000 }) {
  const config = testConfig();
  const store = new JsonStore(config.dataDir);
  const mock = mockFetch(routes);
  const tokens = new TokenManager(config, store, mock.fetchFn, () => now.t);
  return { config, store, tokens, now, ...mock };
}

describe("app token", () => {
  it("uses client credentials with basic auth and caches until near expiry", async () => {
    const now = { t: 0 };
    const { tokens, calls } = setup({ "POST /connect/oauth2/token": [tokenResponse("a1"), tokenResponse("a2")] }, now);

    expect(await tokens.getAppToken()).toBe("a1");
    expect(await tokens.getAppToken()).toBe("a1");
    expect(calls).toHaveLength(1);

    const body = new URLSearchParams(calls[0].body);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("scope")).toBe("product.compact");
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);

    now.t = 1800_000 - 30_000; // inside the refresh skew window
    expect(await tokens.getAppToken()).toBe("a2");
  });

  it("dedupes concurrent token requests", async () => {
    const { tokens, calls } = setup({ "POST /connect/oauth2/token": tokenResponse("a1") });
    await Promise.all([tokens.getAppToken(), tokens.getAppToken(), tokens.getAppToken()]);
    expect(calls).toHaveLength(1);
  });

  it("surfaces Kroger's error description", async () => {
    const { tokens } = setup({
      "POST /connect/oauth2/token": jsonResponse({ error: "invalid_client", error_description: "bad secret" }, 401),
    });
    await expect(tokens.getAppToken()).rejects.toThrow(/401: bad secret/);
  });
});

describe("user token", () => {
  it("throws NotAuthenticatedError when no login is saved", async () => {
    const { tokens } = setup({});
    await expect(tokens.getUserToken()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it("exchanges an auth code and persists tokens", async () => {
    const { tokens, store, calls, config } = setup({
      "POST /connect/oauth2/token": tokenResponse("u1", { refresh_token: "r1", scope: "cart.basic:write" }),
    });
    await tokens.exchangeCode("the-code");

    const body = new URLSearchParams(calls[0].body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("redirect_uri")).toBe(config.redirectUri);
    expect(await tokens.getUserToken()).toBe("u1");
    expect(await store.read("tokens")).toMatchObject({ accessToken: "u1", refreshToken: "r1" });
  });

  it("refreshes an expired token and keeps the refresh token if not rotated", async () => {
    const { tokens, store, calls, now } = setup({ "POST /connect/oauth2/token": tokenResponse("u2") });
    await store.write("tokens", { accessToken: "u1", refreshToken: "r1", expiresAt: now.t - 1 });

    expect(await tokens.getUserToken()).toBe("u2");
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("r1");
    expect(await store.read("tokens")).toMatchObject({ accessToken: "u2", refreshToken: "r1" });
  });

  it("clears saved tokens when the refresh token is rejected", async () => {
    const { tokens, store, now } = setup({
      "POST /connect/oauth2/token": jsonResponse({ error: "invalid_grant" }, 400),
    });
    await store.write("tokens", { accessToken: "u1", refreshToken: "r1", expiresAt: now.t - 1 });

    await expect(tokens.getUserToken()).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(await store.read("tokens")).toBeUndefined();
    expect((await tokens.userStatus()).loggedIn).toBe(false);
  });

  it("builds an authorize URL with cart and profile scopes", () => {
    const { tokens } = setup({});
    const url = new URL(tokens.authorizeUrl("xyz"));
    expect(url.pathname).toBe("/v1/connect/oauth2/authorize");
    expect(url.searchParams.get("scope")).toBe("cart.basic:write profile.compact");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("xyz");
  });
});
