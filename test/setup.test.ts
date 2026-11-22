import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MissingCredentialsError, loadConfig } from "../src/config.js";
import { runSetup } from "../src/setup.js";
import { collectStatus } from "../src/status.js";
import { JsonStore } from "../src/store.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "kroger-mcp-setup-"));

describe("credential loading", () => {
  it("falls back to the credentials file written by setup", async () => {
    const dir = tempDir();
    expect(() => loadConfig({ KROGER_MCP_DATA_DIR: dir })).toThrow(MissingCredentialsError);

    await new JsonStore(dir).write("credentials", { clientId: "file-id", clientSecret: "file-secret" });
    expect(loadConfig({ KROGER_MCP_DATA_DIR: dir })).toMatchObject({
      clientId: "file-id",
      clientSecret: "file-secret",
      credentialsSource: "credentials-file",
    });
    expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("prefers environment variables over the file", async () => {
    const dir = tempDir();
    await new JsonStore(dir).write("credentials", { clientId: "file-id", clientSecret: "file-secret" });
    const config = loadConfig({ KROGER_MCP_DATA_DIR: dir, KROGER_CLIENT_ID: "env-id", KROGER_CLIENT_SECRET: "env-secret" });
    expect(config).toMatchObject({ clientId: "env-id", credentialsSource: "environment" });
  });

  it("tells the user how to run setup when nothing is configured", () => {
    expect(() => loadConfig({ KROGER_MCP_DATA_DIR: tempDir() })).toThrow(/index\.js setup/);
  });
});

describe("status report", () => {
  it("points to setup when credentials are missing, without failing", async () => {
    const status = await collectStatus({ KROGER_MCP_DATA_DIR: tempDir() }, undefined);
    expect(status.credentials).toEqual({ configured: false });
    expect(status.ready).toEqual({ searchTools: false, cartTools: false });
    expect(status.install.mcpServer).toEqual({ command: process.execPath, args: [status.install.entry] });
    expect(status.nextSteps[0]).toMatch(/setup` in their own terminal/);
  });

  it("validates credentials and reports what's left, never echoing the secret", async () => {
    const dir = tempDir();
    const env = { KROGER_MCP_DATA_DIR: dir, KROGER_CLIENT_ID: "id", KROGER_CLIENT_SECRET: "super-secret-value" };
    const { fetchFn } = mockFetch({
      "POST /connect/oauth2/token": jsonResponse({ access_token: "app", expires_in: 1800 }),
    });
    const status = await collectStatus(env, undefined, fetchFn);
    expect(status.credentials).toEqual({ configured: true, source: "environment", valid: true });
    expect(status.ready).toEqual({ searchTools: true, cartTools: false });
    expect(status.krogerLogin).toEqual({ loggedIn: false });
    expect(status.nextSteps.join("\n")).toMatch(/index\.js" auth/);
    expect(JSON.stringify(status)).not.toContain("super-secret-value");
  });

  it("reports rejected credentials", async () => {
    const { fetchFn } = mockFetch({
      "POST /connect/oauth2/token": jsonResponse({ error_description: "invalid credentials" }, 401),
    });
    const status = await collectStatus(
      { KROGER_MCP_DATA_DIR: tempDir(), KROGER_CLIENT_ID: "id", KROGER_CLIENT_SECRET: "bad" },
      undefined,
      fetchFn,
    );
    expect(status.credentials).toMatchObject({ configured: true, valid: false });
    expect(status.credentials.error).toMatch(/invalid credentials/);
  });
});

describe("setup", () => {
  it("refuses to run without a terminal and tells an agent to hand it to the user", async () => {
    // vitest workers have no TTY on stdin.
    await expect(runSetup({ KROGER_MCP_DATA_DIR: tempDir() })).rejects.toThrow(/ask the user to run this/);
  });
});
