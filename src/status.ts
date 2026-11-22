import type { FetchFn, UserAuthStatus } from "./auth.js";
import { type CredentialsSource, ENTRY_PATH, MissingCredentialsError, loadConfig, resolveDataDir } from "./config.js";
import type { PreferredLocation } from "./preferences.js";
import { SERVER_VERSION, createDeps } from "./server.js";

/**
 * Machine-readable setup report printed by `kroger-mcp status`. Meant for both
 * humans and AI agents walking a user through setup; never includes secrets.
 */
export interface SetupStatus {
  version: string;
  install: {
    /** Absolute path to dist/index.js */
    entry: string;
    /** Absolute path to the node binary running this command */
    node: string;
    /** What to register as a stdio MCP server in any client */
    mcpServer: { command: string; args: string[] };
    /** node comes from a version manager, so its path may change when Node is upgraded */
    nodeFromVersionManager: boolean;
  };
  dataDir: string;
  envFile: string | null;
  credentials: { configured: boolean; source?: CredentialsSource; valid?: boolean; error?: string };
  krogerLogin: (Partial<UserAuthStatus> & { loggedIn: boolean; profileId?: string; error?: string }) | null;
  redirectUri?: string;
  preferredLocation: (PreferredLocation & { source: string }) | null;
  ready: { searchTools: boolean; cartTools: boolean };
  nextSteps: string[];
}

const VERSION_MANAGER_PATH = /[\\/](mise|\.nvm|\.asdf|fnm|\.volta)[\\/]/;

export async function collectStatus(
  env: NodeJS.ProcessEnv,
  envFile: string | undefined,
  fetchFn: FetchFn = fetch,
): Promise<SetupStatus> {
  const cmd = (sub: string) => `"${process.execPath}" "${ENTRY_PATH}" ${sub}`;
  const status: SetupStatus = {
    version: SERVER_VERSION,
    install: {
      entry: ENTRY_PATH,
      node: process.execPath,
      mcpServer: { command: process.execPath, args: [ENTRY_PATH] },
      nodeFromVersionManager: VERSION_MANAGER_PATH.test(process.execPath),
    },
    dataDir: resolveDataDir(env),
    envFile: envFile ?? null,
    redirectUri: undefined,
    credentials: { configured: false },
    krogerLogin: null,
    preferredLocation: null,
    ready: { searchTools: false, cartTools: false },
    nextSteps: [],
  };

  let deps;
  try {
    deps = createDeps(loadConfig(env), fetchFn);
  } catch (err) {
    if (!(err instanceof MissingCredentialsError)) status.credentials.error = (err as Error).message;
    status.nextSteps.push(
      `Ask the user to run \`${cmd("setup")}\` in their own terminal. It asks for the Kroger Client ID and ` +
        "Client Secret (hidden input) and stores them in a private file; the secret should not be pasted into chat.",
    );
    return status;
  }

  status.redirectUri = deps.config.redirectUri;
  status.credentials = { configured: true, source: deps.config.credentialsSource };
  try {
    await deps.tokens.getAppToken();
    status.credentials.valid = true;
    status.ready.searchTools = true;
  } catch (err) {
    status.credentials.valid = false;
    status.credentials.error = (err as Error).message;
    status.nextSteps.push(
      deps.config.credentialsSource === "environment"
        ? "Kroger rejected the credentials from KROGER_CLIENT_ID/KROGER_CLIENT_SECRET (environment or .env); fix them there."
        : `Kroger rejected the saved credentials; have the user re-run \`${cmd("setup")}\` with the correct Client ID and Secret.`,
    );
  }

  if ((await deps.tokens.userStatus()).loggedIn) {
    try {
      // This also refreshes an expired access token, so read the login status afterwards.
      const profileId = (await deps.client.getProfile()).data.id;
      status.krogerLogin = { ...(await deps.tokens.userStatus()), profileId };
      status.ready.cartTools = true;
    } catch (err) {
      status.krogerLogin = { ...(await deps.tokens.userStatus()), error: (err as Error).message };
    }
  } else {
    status.krogerLogin = { loggedIn: false };
  }
  if (!status.ready.cartTools && status.credentials.valid) {
    status.nextSteps.push(
      `To enable cart tools, have the user run \`${cmd("auth")}\` in their own terminal and sign in to Kroger. ` +
        `${deps.config.redirectUri} must be registered as a redirect URI on their Kroger app. If they're on a remote ` +
        "machine over SSH, they need `ssh -L 8000:localhost:8000 <host>` so the browser redirect reaches it.",
    );
  }

  status.preferredLocation = (await deps.prefs.getLocation()) ?? null;
  if (!status.preferredLocation && status.ready.searchTools) {
    status.nextSteps.push(
      "Optional: once connected, set a default store with search_locations then set_preferred_location " +
        "so product results include local prices and stock.",
    );
  }

  if (status.ready.searchTools) {
    status.nextSteps.push(
      "Register install.mcpServer (command + args) as a stdio MCP server named \"kroger\" in the user's MCP client " +
        "if not already done, then restart the client. Do not put credentials in the client's config.",
    );
    if (status.install.nodeFromVersionManager) {
      status.nextSteps.push(
        "install.node is inside a Node version manager (mise/nvm/asdf/fnm/volta), so that path can change when Node " +
          "is upgraded. Tell the user to re-run status and update the client config after upgrading Node.",
      );
    }
  }
  return status;
}
