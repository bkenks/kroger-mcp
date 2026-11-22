import { join } from "node:path";
import { TokenManager } from "./auth.js";
import { openBrowser } from "./browser.js";
import {
  API_BASES,
  CREDENTIALS_KEY,
  type Config,
  ENTRY_PATH,
  MissingCredentialsError,
  loadConfig,
  resolveDataDir,
} from "./config.js";
import { formatLocation } from "./format.js";
import { ask, askHidden, askYesNo } from "./prompt.js";
import { createDeps } from "./server.js";
import { JsonStore } from "./store.js";

const DEV_PORTAL = "https://developer.kroger.com";

/**
 * Interactive first-time setup, meant to be run by the user in their own
 * terminal: save API credentials privately, log in to Kroger, pick a store.
 */
export async function runSetup(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "`setup` is interactive and needs a terminal. If you are an AI agent, ask the user to run this " +
        `in their own terminal (don't collect the Client Secret in chat):\n\n  "${process.execPath}" "${ENTRY_PATH}" setup`,
    );
  }
  const dataDir = resolveDataDir(env);
  const store = new JsonStore(dataDir);
  const redirectUri = env.KROGER_REDIRECT_URI?.trim() || "http://localhost:8000/callback";

  console.log(`
Kroger MCP setup
================
You need a (free) Kroger developer app. If you don't have one yet:
  1. Sign in at ${DEV_PORTAL} and create an application (Manage → Applications).
  2. Give it access to the Products, Locations, Cart, and Identity APIs.
  3. Add this redirect URI exactly:  ${redirectUri}
  4. Copy the app's Client ID and Client Secret.
`);

  // --- Step 1: credentials ---------------------------------------------------------------------
  let config = tryLoadConfig(env);
  let replace = true;
  if (config) {
    const where = config.credentialsSource === "environment" ? "environment variables / .env" : "the saved credentials file";
    console.log(`Credentials are already configured (from ${where}).`);
    replace = await askYesNo("Enter new ones?", false);
    if (replace && config.credentialsSource === "environment") {
      console.log(
        "Note: KROGER_CLIENT_ID/KROGER_CLIENT_SECRET in the environment or .env take precedence over the saved file;\n" +
          "remove them there if you want the new credentials to be used.",
      );
    }
  }
  if (replace) {
    const creds = await promptCredentials(env, dataDir, redirectUri);
    await store.write(CREDENTIALS_KEY, { ...creds, savedAt: new Date().toISOString() });
    console.log(`✓ Saved to ${join(dataDir, `${CREDENTIALS_KEY}.json`)} (readable only by your user).\n`);
    config = tryLoadConfig(env);
  }
  if (!config) throw new MissingCredentialsError();
  const deps = createDeps(config);

  // --- Step 2: Kroger account login (cart + profile) -------------------------------------------
  const login = await deps.tokens.userStatus();
  const wantLogin = login.loggedIn
    ? await askYesNo("You're already logged in to Kroger. Log in again?", false)
    : await askYesNo("Log in to your Kroger account now? (needed for adding to your cart)", true);
  if (wantLogin) {
    while (true) {
      try {
        const { url, done } = await deps.tokens.startLogin();
        console.log(`\nOpen this URL to sign in to Kroger:\n\n  ${url}\n`);
        console.log(
          "If your browser is on a different computer (e.g. you're connected over SSH), forward the port first:\n" +
            `  ssh -L ${new URL(config.redirectUri).port || 80}:localhost:${new URL(config.redirectUri).port || 80} <this-host>\n`,
        );
        openBrowser(url);
        console.log("Waiting for you to finish signing in (up to 10 minutes)...");
        await done;
        console.log("✓ Logged in to Kroger.\n");
        break;
      } catch (err) {
        console.log(`✗ ${(err as Error).message}`);
        if (!(await askYesNo("Try again?", true))) break;
      }
    }
  }

  // --- Step 3: default store ---------------------------------------------------------------------
  const current = await deps.prefs.getLocation();
  if (current?.source === "saved") {
    console.log(`Default store: ${current.name ?? current.locationId}${current.address ? `, ${current.address}` : ""}`);
  } else {
    const zip = await ask("ZIP code to pick a default store for prices and stock (Enter to skip): ");
    if (/^\d{5}$/.test(zip)) {
      try {
        const stores = (await deps.client.searchLocations({ zipCode: zip, limit: 5 })).data.map((l) => formatLocation(l));
        if (!stores.length) console.log("No stores found near that ZIP; you can pick one later by asking your assistant.");
        stores.forEach((s, i) => console.log(`  ${i + 1}. ${s.name} — ${s.address}`));
        const pick = Number(await ask(`Choose 1-${stores.length} (Enter to skip): `));
        const chosen = stores[pick - 1];
        if (chosen?.locationId) {
          await deps.prefs.setLocation({ locationId: chosen.locationId, name: chosen.name, address: chosen.address });
          console.log(`✓ Default store set to ${chosen.name}.`);
        }
      } catch (err) {
        console.log(`Couldn't look up stores (${(err as Error).message}); you can pick one later.`);
      }
    } else if (zip) {
      console.log("That isn't a 5-digit ZIP; skipping. You can pick a store later by asking your assistant.");
    }
  }

  console.log(`
Setup complete. Register the server with your AI app as a stdio MCP server:
  command: ${process.execPath}
  args:    ${ENTRY_PATH}

For example, in Claude Code:
  claude mcp add --scope user kroger -- "${process.execPath}" "${ENTRY_PATH}"

Your credentials stay in ${dataDir}; don't put them in the AI app's config.
Check everything any time with:  "${process.execPath}" "${ENTRY_PATH}" status
`);
}

function tryLoadConfig(env: NodeJS.ProcessEnv): Config | undefined {
  try {
    return loadConfig(env);
  } catch (err) {
    if (err instanceof MissingCredentialsError) return undefined;
    throw err;
  }
}

/** Ask for credentials until Kroger accepts them (verified with a client-credentials token request). */
async function promptCredentials(env: NodeJS.ProcessEnv, dataDir: string, redirectUri: string) {
  while (true) {
    const clientId = await ask("Kroger Client ID: ");
    const clientSecret = await askHidden("Kroger Client Secret (input hidden): ");
    if (!clientId || !clientSecret) {
      console.log("Both values are required.\n");
      continue;
    }
    process.stdout.write("Checking with Kroger... ");
    const probe = new TokenManager(
      {
        clientId,
        clientSecret,
        credentialsSource: "credentials-file",
        redirectUri,
        apiBase: API_BASES[env.KROGER_ENV?.trim() === "cert" ? "cert" : "prod"],
        dataDir,
      },
      new JsonStore(dataDir),
    );
    try {
      await probe.getAppToken();
      console.log("✓ accepted.");
      return { clientId, clientSecret };
    } catch (err) {
      console.log(`✗ ${(err as Error).message}`);
      if (!(await askYesNo("Try again?", true))) throw new Error("Setup cancelled; no credentials were saved.");
    }
  }
}
