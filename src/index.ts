#!/usr/bin/env node
import { spawn } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadDotEnv, loadHttpConfig } from "./config.js";
import { KROGER_CALLBACK_PATH, remoteLoginFlow, startHttpServer } from "./http/app.js";
import { createDeps, createServer } from "./server.js";

const USAGE = `Usage: kroger-mcp [command]

Commands:
  (none)   Start the MCP server on stdio (launched on demand by an MCP client)
  serve    Start an always-on remote MCP server over HTTP with OAuth (see README)
  auth     Log in to your Kroger account in the browser (enables cart tools)
  logout   Delete saved Kroger account tokens
  status   Show login status and Kroger profile ID`;

async function main() {
  const command = process.argv[2];
  if (command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    return;
  }

  loadDotEnv();
  if (command === "serve") return serve();
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
    case "status": {
      const status = await deps.tokens.userStatus();
      // The profile ID is what KROGER_ALLOWED_PROFILE_ID expects in serve mode.
      const profileId = status.loggedIn ? (await deps.client.getProfile()).data.id : undefined;
      console.log(JSON.stringify({ ...status, ...(profileId && { profileId }) }, null, 2));
      return;
    }
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

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // no browser available; the URL is printed anyway
    child.unref();
  } catch {
    // ignore
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
