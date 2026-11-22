#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openBrowser } from "./browser.js";
import { loadConfig, loadDotEnv, loadHttpConfig } from "./config.js";
import { KROGER_CALLBACK_PATH, remoteLoginFlow, startHttpServer } from "./http/app.js";
import { createDeps, createServer } from "./server.js";
import { runSetup } from "./setup.js";
import { collectStatus } from "./status.js";

const USAGE = `Usage: kroger-mcp [command]

Commands:
  (none)   Start the MCP server on stdio (launched on demand by an MCP client)
  setup    Interactive first-time setup: save API credentials, log in, pick a store
  status   Print a JSON setup report: install paths, credentials, login, next steps
  auth     Log in to your Kroger account in the browser (enables cart tools)
  logout   Delete saved Kroger account tokens
  serve    Start an always-on remote MCP server over HTTP with OAuth (see README)`;

async function main() {
  const command = process.argv[2];
  if (command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    return;
  }

  const envFile = loadDotEnv();
  if (command === "serve") return serve();
  if (command === "setup") return runSetup();
  if (command === "status") {
    console.log(JSON.stringify(await collectStatus(process.env, envFile), null, 2));
    return;
  }
  const deps = createDeps(loadConfig());

  switch (command) {
    case undefined: {
      const server = createServer(deps);
      await server.connect(new StdioServerTransport());
      // stdout is the MCP channel; log to stderr only.
      console.error(`Kroger MCP server running (${deps.config.apiBase})`);
      return;
    }
    case "auth": {
      const { url, done } = await deps.tokens.startLogin();
      console.log(`Open this URL to log in to Kroger:\n\n  ${url}\n\nWaiting for the redirect to ${deps.config.redirectUri} ...`);
      openBrowser(url);
      await done;
      console.log("Logged in. Cart tools are now available.");
      return;
    }
    case "logout":
      await deps.tokens.logout();
      console.log("Logged out.");
      return;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

async function serve() {
  const http = loadHttpConfig();
  const deps = createDeps(loadConfig(process.env, { redirectUri: http.krogerRedirectUri }));
  deps.login = remoteLoginFlow(http);

  const server = await startHttpServer(deps, http);
  console.error(
    [
      `Kroger MCP HTTP server listening on http://${http.host}:${http.port}`,
      `  MCP endpoint:       ${http.mcpUrl.href}`,
      `  Kroger redirect URI (register it on your Kroger app): ${new URL(KROGER_CALLBACK_PATH, http.publicUrl).href}`,
      `  Static API key:     ${http.apiKey ? "enabled" : "disabled"}`,
      `  Allowed account:    ${http.allowedProfileId ?? "owner of the saved Kroger login (if any)"}`,
    ].join("\n"),
  );

  const shutdown = () => {
    console.error("Shutting down...");
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
