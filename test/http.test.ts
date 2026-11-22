import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, loadHttpConfig } from "../src/config.js";
import { createHttpApp, remoteLoginFlow } from "../src/http/app.js";
import { createDeps } from "../src/server.js";
import { JsonStore } from "../src/store.js";
import { jsonResponse, mockFetch, testConfig } from "./helpers.js";

const CLIENT_REDIRECT = "http://localhost:7777/cb";
const PROFILES: Record<string, string> = { "owner-kroger-token": "owner-id", "stranger-kroger-token": "stranger-id" };

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function start(env: Record<string, string> = {}) {
  const http = loadHttpConfig({ MCP_PUBLIC_URL: "http://localhost", ...env });
  const config = { ...testConfig(), redirectUri: http.krogerRedirectUri };
  const mock = mockFetch({
    "POST /connect/oauth2/token": (call) => {
      const body = new URLSearchParams(call.body);
      if (body.get("grant_type") === "client_credentials") return jsonResponse({ access_token: "app", expires_in: 1800 })();
      // Kroger auth codes in these tests are "owner-code" / "stranger-code".
      const who = body.get("code")?.replace("-code", "");
      return jsonResponse({ access_token: `${who}-kroger-token`, refresh_token: `${who}-r`, expires_in: 1800 })();
    },
    "GET /identity/profile": (call) => {
      const id = PROFILES[call.headers.authorization.replace("Bearer ", "")];
      return id ? jsonResponse({ data: { id } })() : jsonResponse({}, 401)();
    },
    "GET /chains": jsonResponse({ data: [{ name: "KROGER" }] }),
  });
  const deps = createDeps(config, mock.fetchFn);
  deps.login = remoteLoginFlow(http);
  const server = createHttpApp(deps, http).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, http, config, store: new JsonStore(config.dataDir), ...mock };
}

const savedKrogerLogin = (store: JsonStore) => store.read<{ accessToken: string }>("tokens");

/** Walks an MCP client through register → authorize → consent → Kroger → callback. */
async function authorize(base: string, opts: { krogerCode: string; approve?: boolean; withCookie?: boolean }) {
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test Client", redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none" }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = await reg.json();

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authUrl = new URL(`${base}/authorize`);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "client-state",
    resource: "http://localhost/mcp",
  }).toString();

  const consentPage = await fetch(authUrl, { redirect: "manual" });
  expect(consentPage.status).toBe(200);
  const html = await consentPage.text();
  expect(html).toContain("Test Client");
  expect(html).toContain("localhost:7777");
  const requestId = html.match(/name="request" value="([^"]+)"/)![1];
  const cookie = consentPage.headers.get("set-cookie")!.split(";")[0];

  const consent = await fetch(`${base}/oauth/consent`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(opts.withCookie !== false && { Cookie: cookie }),
    },
    body: new URLSearchParams({ request: requestId, action: opts.approve === false ? "deny" : "approve" }).toString(),
  });
  if (consent.status !== 302) return { client_id, verifier, consent, final: consent };
  const krogerUrl = new URL(consent.headers.get("location")!);
  if (krogerUrl.host !== "api.kroger.com") return { client_id, verifier, consent, final: consent };

  expect(krogerUrl.searchParams.get("redirect_uri")).toBe("http://localhost/kroger/callback");
  const callback = await fetch(
    `${base}/kroger/callback?code=${opts.krogerCode}&state=${krogerUrl.searchParams.get("state")}`,
    { redirect: "manual" },
  );
  return { client_id, verifier, consent, final: callback };
}

async function exchangeCode(base: string, client_id: string, verifier: string, location: string) {
  const code = new URL(location).searchParams.get("code")!;
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id,
      redirect_uri: CLIENT_REDIRECT,
      resource: "http://localhost/mcp",
    }).toString(),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}

async function mcpClient(base: string, token: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe("HTTP serve mode", () => {
  it("publishes OAuth discovery metadata", async () => {
    const { base } = await start({ KROGER_ALLOWED_PROFILE_ID: "owner-id" });
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      issuer: "http://localhost/",
      authorization_endpoint: "http://localhost/authorize",
      token_endpoint: "http://localhost/token",
      registration_endpoint: "http://localhost/register",
      code_challenge_methods_supported: ["S256"],
    });
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(pr.resource).toBe("http://localhost/mcp");
  });

  it("rejects unauthenticated MCP requests with a discovery hint", async () => {
    const { base } = await start({ KROGER_ALLOWED_PROFILE_ID: "owner-id" });
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("lets the owner authorize a client, saves their Kroger login, and serves MCP tools", async () => {
    const { base, store } = await start({ KROGER_ALLOWED_PROFILE_ID: "owner-id" });
    const { client_id, verifier, final } = await authorize(base, { krogerCode: "owner-code" });

    expect(final.status).toBe(302);
    const location = final.headers.get("location")!;
    expect(location.startsWith(CLIENT_REDIRECT)).toBe(true);
    expect(new URL(location).searchParams.get("state")).toBe("client-state");
    expect((await savedKrogerLogin(store))?.accessToken).toBe("owner-kroger-token");

    const tokens = await exchangeCode(base, client_id, verifier, location);
    expect(tokens.expires_in).toBe(3600);

    const client = await mcpClient(base, tokens.access_token);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("add_to_cart");
    const chains = await client.callTool({ name: "list_chains", arguments: {} });
    expect((chains.content as Array<{ text: string }>)[0].text).toContain("KROGER");
    const profile = await client.callTool({ name: "get_profile", arguments: {} });
    expect((profile.content as Array<{ text: string }>)[0].text).toContain("owner-id");
    const login = await client.callTool({ name: "kroger_login", arguments: {} });
    expect((login.content as Array<{ text: string }>)[0].text).toContain("http://localhost/kroger/login");
    await client.close();

    // Only hashes of issued tokens are persisted.
    expect(JSON.stringify(await store.read("oauth-tokens"))).not.toContain(tokens.access_token);
  });

  it("rejects a different Kroger account without touching the saved login", async () => {
    const { base, store } = await start({ KROGER_ALLOWED_PROFILE_ID: "owner-id" });
    const { final } = await authorize(base, { krogerCode: "stranger-code" });

    expect(final.status).toBe(302);
    const location = new URL(final.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
    expect(await savedKrogerLogin(store)).toBeUndefined();
  });

  it("derives the owner from an existing saved Kroger login when none is configured", async () => {
    const { base, store } = await start();
    await store.write("tokens", { accessToken: "owner-kroger-token", refreshToken: "r", expiresAt: Date.now() + 3600_000 });

    const stranger = await authorize(base, { krogerCode: "stranger-code" });
    expect(new URL(stranger.final.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    expect(await store.read("owner")).toEqual({ profileId: "owner-id" });

    const owner = await authorize(base, { krogerCode: "owner-code" });
    expect(new URL(owner.final.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  it("refuses everyone when no owner can be determined, showing the profile ID to configure", async () => {
    const { base, store } = await start();
    const { final } = await authorize(base, { krogerCode: "stranger-code" });
    expect(final.status).toBe(403);
    expect(await final.text()).toContain("KROGER_ALLOWED_PROFILE_ID=stranger-id");
    expect(await savedKrogerLogin(store)).toBeUndefined();
  });

  it("requires the consent cookie from the same browser, and honors deny", async () => {
    const { base } = await start({ KROGER_ALLOWED_PROFILE_ID: "owner-id" });

    const noCookie = await authorize(base, { krogerCode: "owner-code", withCookie: false });
    expect(noCookie.final.status).toBe(400);

    const denied = await authorize(base, { krogerCode: "owner-code", approve: false });
    expect(denied.final.status).toBe(302);
    expect(new URL(denied.final.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("rotates refresh tokens", async () => {
    const { base } = await start({ KROGER_ALLOWED_PROFILE_ID: "owner-id" });
    const { client_id, verifier, final } = await authorize(base, { krogerCode: "owner-code" });
    const first = await exchangeCode(base, client_id, verifier, final.headers.get("location")!);

    const refresh = (token: string) =>
      fetch(`${base}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id }).toString(),
      });
    const second = await refresh(first.refresh_token);
    expect(second.status).toBe(200);
    const { access_token } = await second.json();
    expect(access_token).not.toBe(first.access_token);
    expect((await refresh(first.refresh_token)).status).toBe(400);
  });

  it("accepts the static API key when configured", async () => {
    const apiKey = "k".repeat(40);
    const { base } = await start({ KROGER_ALLOWED_PROFILE_ID: "owner-id", MCP_API_KEY: apiKey });
    const client = await mcpClient(base, apiKey);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
    await expect(mcpClient(base, "k".repeat(39) + "x")).rejects.toThrow();
  });

  it("reconnects the Kroger login via /kroger/login for the owner only", async () => {
    const { base, store } = await start({ KROGER_ALLOWED_PROFILE_ID: "owner-id" });
    const go = async (code: string) => {
      const start = await fetch(`${base}/kroger/login`, { redirect: "manual" });
      const state = new URL(start.headers.get("location")!).searchParams.get("state");
      return fetch(`${base}/kroger/callback?code=${code}&state=${state}`, { redirect: "manual" });
    };
    expect((await go("stranger-code")).status).toBe(403);
    expect(await savedKrogerLogin(store)).toBeUndefined();
    const ok = await go("owner-code");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toMatch(/connected/i);
    expect((await savedKrogerLogin(store))?.accessToken).toBe("owner-kroger-token");
  });

  it("rejects requests for unexpected Host headers", async () => {
    const { base } = await start({ KROGER_ALLOWED_PROFILE_ID: "owner-id" });
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/.well-known/oauth-authorization-server`, { headers: { Host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe("loadHttpConfig", () => {
  it("requires https except for localhost, and an origin-only URL", () => {
    expect(() => loadHttpConfig({ MCP_PUBLIC_URL: "http://kroger.example.com" })).toThrow(/https/);
    expect(() => loadHttpConfig({ MCP_PUBLIC_URL: "https://kroger.example.com/sub" })).toThrow(/no path/);
    expect(() => loadHttpConfig({})).toThrow(/MCP_PUBLIC_URL is required/);
    expect(() => loadHttpConfig({ MCP_PUBLIC_URL: "https://k.example.com", MCP_API_KEY: "short" })).toThrow(/32/);
  });

  it("derives endpoints and defaults", () => {
    const h = loadHttpConfig({ MCP_PUBLIC_URL: "https://kroger.example.com", PORT: "8080" });
    expect(h.mcpUrl.href).toBe("https://kroger.example.com/mcp");
    expect(h.krogerRedirectUri).toBe("https://kroger.example.com/kroger/callback");
    expect(h.port).toBe(8080);
    expect(h.host).toBe("127.0.0.1");
    expect(h.allowedHosts).toContain("kroger.example.com");
  });

  it("feeds the derived redirect URI into the Kroger config", () => {
    const c = loadConfig({ KROGER_CLIENT_ID: "a", KROGER_CLIENT_SECRET: "b" }, { redirectUri: "https://x/kroger/callback" });
    expect(c.redirectUri).toBe("https://x/kroger/callback");
  });
});
