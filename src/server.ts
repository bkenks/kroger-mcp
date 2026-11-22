import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type FetchFn, TokenManager } from "./auth.js";
import { KrogerClient } from "./client.js";
import type { Config } from "./config.js";
import { Preferences } from "./preferences.js";
import { JsonStore } from "./store.js";
import { registerAccountTools } from "./tools/account.js";
import { registerLocationTools } from "./tools/locations.js";
import { registerProductTools } from "./tools/products.js";
import type { Deps } from "./tools/shared.js";

export const SERVER_VERSION = "0.1.0";

export function createDeps(config: Config, fetchFn: FetchFn = fetch): Deps {
  const store = new JsonStore(config.dataDir);
  const tokens = new TokenManager(config, store, fetchFn);
  return {
    config,
    tokens,
    client: new KrogerClient(config, tokens, fetchFn),
    prefs: new Preferences(store, config.defaultLocationId),
  };
}

export function createServer(deps: Deps): McpServer {
  const server = new McpServer(
    { name: "kroger", version: SERVER_VERSION },
    {
      instructions:
        "Tools for Kroger grocery stores (Kroger, Ralphs, Fred Meyer, King Soopers, Harris Teeter, etc.). " +
        "Typical flow: search_locations by ZIP → set_preferred_location → search_products (prices/stock are " +
        "store-specific) → add_to_cart with UPCs. Cart tools need a one-time kroger_login. The API can add to the " +
        "cart but cannot view or remove cart items.",
    },
  );
  registerProductTools(server, deps);
  registerLocationTools(server, deps);
  registerAccountTools(server, deps);
  return server;
}
