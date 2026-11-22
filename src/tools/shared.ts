import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TokenManager } from "../auth.js";
import type { KrogerClient } from "../client.js";
import type { Config } from "../config.js";
import type { Preferences } from "../preferences.js";

/** How the kroger_login tool connects a Kroger account; differs between stdio and HTTP mode. */
export interface LoginFlow {
  start(): Promise<{ loginUrl: string; instructions: string }>;
}

export interface Deps {
  config: Config;
  client: KrogerClient;
  tokens: TokenManager;
  prefs: Preferences;
  login: LoginFlow;
}

export function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const NO_LOCATION_NOTE =
  "No store selected, so prices, stock, and aisles are omitted. Use search_locations, then " +
  "set_preferred_location (or pass locationId).";
