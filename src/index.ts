#!/usr/bin/env node
import { spawn } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { createDeps, createServer } from "./server.js";

const USAGE = `Usage: kroger-mcp [command]

Commands:
  (none)   Start the MCP server on stdio
  auth     Log in to your Kroger account in the browser (enables cart tools)
  logout   Delete saved Kroger account tokens
  status   Show login status`;

async function main() {
  const command = process.argv[2];
  if (command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    return;
  }

  loadDotEnv();
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
    case "status":
      console.log(JSON.stringify(await deps.tokens.userStatus(), null, 2));
      return;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
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
