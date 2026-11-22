import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

/** A fetch stub that routes by "METHOD /path" and records every call. */
export function mockFetch(routes: Record<string, Responder | Responder[]>) {
  const calls: RecordedCall[] = [];
  const counters: Record<string, number> = {};
  const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: RecordedCall = {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${url.pathname.replace(/^\/v1/, "")}`;
    const route = routes[key];
    if (!route) throw new Error(`Unmocked request: ${key}`);
    if (Array.isArray(route)) {
      const i = counters[key] ?? 0;
      counters[key] = i + 1;
      return route[Math.min(i, route.length - 1)](call);
    }
    return route(call);
  }) as typeof fetch;
  return { fetchFn, calls, callsTo: (key: string) => calls.filter((c) => `${c.method} ${c.url.pathname.replace(/^\/v1/, "")}` === key) };
}

export const jsonResponse = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const tokenResponse = (accessToken: string, extra: Record<string, unknown> = {}) =>
  jsonResponse({ access_token: accessToken, token_type: "bearer", expires_in: 1800, ...extra });

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    credentialsSource: "environment",
    redirectUri: "http://localhost:8000/callback",
    apiBase: "https://api.kroger.com/v1",
    dataDir: mkdtempSync(join(tmpdir(), "kroger-mcp-test-")),
    ...overrides,
  };
}
