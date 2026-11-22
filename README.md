# kroger-mcp

An [MCP](https://modelcontextprotocol.io) server for the [Kroger Public API](https://developer.kroger.com).
It lets an assistant find stores, search products with live store prices, stock, and aisle info, and add
items to your Kroger cart. It covers every Kroger-family banner: Kroger, Ralphs, Fred Meyer, King Soopers,
Harris Teeter, Smith's, Fry's, QFC, and the rest.

## Tools

| Tool | What it does | Needs login |
|---|---|---|
| `search_locations` | Find stores near a ZIP code or lat/lon | |
| `get_location` | Store address, weekly hours, departments | |
| `list_chains` / `list_departments` | Reference data for filtering store searches | |
| `set_preferred_location` / `get_preferred_location` | Save a default store for prices and stock (persists) | |
| `search_products` | Search by keyword, brand, or product IDs; returns UPC, price, sale price, stock, aisle | |
| `get_product` | One product's details and image | |
| `kroger_login` | Start the browser login and return the URL to open | |
| `auth_status` / `kroger_logout` | Check or clear the saved login | |
| `add_to_cart` | Add items by UPC for pickup or delivery | ✓ |
| `get_profile` | Kroger profile ID | ✓ |

Prices, stock, and aisles are store-specific. They only appear once a store is chosen with
`set_preferred_location`, the `locationId` argument, or `KROGER_LOCATION_ID`. The Kroger API can **add** to
the cart but cannot read or remove cart items, so review your cart at kroger.com.

## Setup

1. **Create a Kroger app** at <https://developer.kroger.com>, under *Manage → Applications*:
   - Turn on the **Products**, **Locations**, **Cart**, and **Identity** APIs.
   - Add the redirect URI **`http://localhost:8000/callback`**. It must match exactly. To use a different
     port, register that URI and set `KROGER_REDIRECT_URI` to it.
2. **Configure credentials.** Copy `.env.example` to `.env` and fill in `KROGER_CLIENT_ID` and
   `KROGER_CLIENT_SECRET`. The server reads `.env` from the project directory no matter where the MCP
   client launches it from. Variables already set in the environment take precedence.
3. **Build:**
   ```sh
   npm install
   npm run build
   ```
4. **Log in (optional, for cart tools).** Either ask the assistant to call `kroger_login`, or run:
   ```sh
   npm run auth        # opens the browser and waits for the redirect
   ```
   Tokens are stored in `~/.config/kroger-mcp/tokens.json` with `0600` permissions and refresh
   automatically.

## Connect to a client

**Claude Code**
```sh
claude mcp add kroger -- node /absolute/path/to/kroger-mcp/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "kroger": {
      "command": "node",
      "args": ["/absolute/path/to/kroger-mcp/dist/index.js"]
    }
  }
}
```

You can also pass `KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET` through the client's `env` block
instead of using a `.env` file.

## Configuration

| Variable | Default | |
|---|---|---|
| `KROGER_CLIENT_ID` / `KROGER_CLIENT_SECRET` | (required) | From your Kroger app |
| `KROGER_REDIRECT_URI` | `http://localhost:8000/callback` | Must be `http://localhost…` and registered on the app |
| `KROGER_ENV` | `prod` | `cert` uses Kroger's certification environment |
| `KROGER_LOCATION_ID` | (none) | Fallback store when no preferred location is saved |
| `KROGER_MCP_DATA_DIR` | `~/.config/kroger-mcp` | Where tokens and preferences are kept |

## CLI

```
node dist/index.js           # run the MCP server on stdio
node dist/index.js auth      # browser login
node dist/index.js status    # show login status
node dist/index.js logout    # delete saved tokens
```

## Development

```sh
npm run dev         # run from source with tsx
npm test            # vitest (fetch is mocked; no network)
npm run typecheck   # type-check src and tests
npx @modelcontextprotocol/inspector node dist/index.js   # poke at tools interactively
```
