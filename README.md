# kroger-mcp

An [MCP](https://modelcontextprotocol.io) server for the [Kroger Public API](https://developer.kroger.com).
It lets an assistant find stores, search products with live store prices, stock, and aisle info, and add
items to your Kroger cart. It covers every Kroger-family banner: Kroger, Ralphs, Fred Meyer, King Soopers,
Harris Teeter, Smith's, Fry's, QFC, and the rest.

It runs in two modes:

- **Local (stdio)**, the default. Your MCP client (Claude Code or Desktop) starts the server on demand
  as a subprocess. No network exposure; setup is below.
- **Remote (HTTP)**, via `kroger-mcp serve`. An always-on server at a URL, protected by OAuth that signs
  you in with your Kroger account. Use it from claude.ai and the Claude mobile apps. See
  [Remote mode](#remote-mode-always-on-http).

## Quick start: let your AI agent set it up

Paste this into an AI agent that can run terminal commands, such as Claude Code, Codex, Cursor, or
Gemini CLI:

```text
Install and set up the Kroger MCP server for me by following the instructions at
https://raw.githubusercontent.com/bkenks/kroger-mcp/main/AGENT_INSTALL.md
```

The agent will:
- install the server;
- walk you through creating a free Kroger developer app;
- have you run a short interactive `setup` in your own terminal, so your Client Secret never goes
  through the chat;
- register the server with your AI app.

[`AGENT_INSTALL.md`](AGENT_INSTALL.md) is the exact guide it follows.

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

## Manual setup

1. **Install** to `~/.local/share/kroger-mcp`. Re-run the same command to update.
   ```sh
   curl -fsSL https://raw.githubusercontent.com/bkenks/kroger-mcp/main/install.sh | bash
   ```
   Or clone the repo anywhere and run `npm ci --ignore-scripts && npm run build`.
2. **Create a Kroger app** at <https://developer.kroger.com>, under *Manage → Applications*:
   - Turn on the **Products**, **Locations**, **Cart**, and **Identity** APIs.
   - Add the redirect URI **`http://localhost:8000/callback`**. It must match exactly.
3. **Run setup** in your terminal:
   ```sh
   node ~/.local/share/kroger-mcp/dist/index.js setup
   ```
   It asks for your Client ID and Client Secret (hidden input) and checks them with Kroger. It saves them
   to `~/.config/kroger-mcp/credentials.json`, which only your user can read. Then it logs you in to
   Kroger for the cart tools and lets you pick a default store. Your Kroger login is stored next to the
   credentials and refreshes automatically.
4. **Register the server with your AI app.** Run `node ~/.local/share/kroger-mcp/dist/index.js status`
   for a JSON report. It includes the exact command to register (`install.mcpServer`), what's configured,
   and any remaining steps.

### Where credentials can live

In order of precedence:
1. `KROGER_CLIENT_ID` / `KROGER_CLIENT_SECRET` environment variables;
2. a `.env` file in the install directory (see `.env.example`);
3. the file written by `setup`.

The `setup` file is the recommended option. It stays out of the repo and out of your AI app's config,
which may be synced or readable by the AI. It's protected the same way as the Kroger login tokens.

## Connect to a client

Use the absolute paths from `status`. Using `node` from `PATH` may fail in GUI apps, or with version
managers like mise or nvm.

**Claude Code**
```sh
claude mcp add --scope user kroger -- /absolute/path/to/node /absolute/path/to/kroger-mcp/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`), Cursor (`~/.cursor/mcp.json`), and most other clients:
```json
{
  "mcpServers": {
    "kroger": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/kroger-mcp/dist/index.js"]
    }
  }
}
```

[`AGENT_INSTALL.md`](AGENT_INSTALL.md#step-5-register-the-server-with-the-users-mcp-client) covers
more clients. Don't put credentials in these configs.

## Configuration

| Variable | Default | |
|---|---|---|
| `KROGER_CLIENT_ID` / `KROGER_CLIENT_SECRET` | from `setup` | Override the credentials saved by `setup` |
| `KROGER_REDIRECT_URI` | `http://localhost:8000/callback` | Must be `http://localhost…` and registered on the app |
| `KROGER_ENV` | `prod` | `cert` uses Kroger's certification environment |
| `KROGER_LOCATION_ID` | (none) | Fallback store when no preferred location is saved |
| `KROGER_MCP_DATA_DIR` | `~/.config/kroger-mcp` | Where credentials, tokens, and preferences are kept |

## CLI

```
node dist/index.js           # run the MCP server on stdio
node dist/index.js setup     # interactive setup: credentials, Kroger login, default store
node dist/index.js status    # JSON setup report: paths, credentials, login, next steps
node dist/index.js auth      # Kroger browser login only
node dist/index.js logout    # delete the saved Kroger login
node dist/index.js serve     # run the remote HTTP server (see Remote mode)
```

## Remote mode (always-on HTTP)

`kroger-mcp serve` runs the same tools over
[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) at
`$MCP_PUBLIC_URL/mcp`. It acts as its own OAuth server, so claude.ai, the mobile apps, and Claude Code
can connect with a normal sign-in flow.

### How sign-in works

1. A client (for example a claude.ai custom connector) registers itself and opens `/authorize`.
2. The server shows a **consent page** naming the app and where it will be redirected. Approve only
   if you just started connecting that app.
3. You're sent to **Kroger's login**. When you come back, the server checks the Kroger profile ID.
   Only the owner's account is accepted, and any other account is refused before anything is saved.
4. Your Kroger login is saved for the cart tools, and the client receives its own access token
   (valid 1 hour and refreshed automatically; refresh tokens rotate on use and expire after 90 days unused).

The **owner** is `KROGER_ALLOWED_PROFILE_ID` if set. Otherwise it's the account of the Kroger login
already saved in the data directory, for example from `kroger-mcp auth`. If neither exists, sign-in is
refused and the error page shows the profile ID to put in `KROGER_ALLOWED_PROFILE_ID`. To print your
ID, run `node dist/index.js status`.

The server keeps only SHA-256 hashes of the tokens it issues. Its own files (`oauth-clients.json`,
`oauth-tokens.json`, `owner.json`) sit next to the Kroger login in the data directory.

### Setup

1. **Pick a public HTTPS hostname**, for example `https://kroger.example.com`, and put it in `.env`:
   ```sh
   MCP_PUBLIC_URL=https://kroger.example.com
   ```
2. **Register a second redirect URI** on your Kroger app: `https://kroger.example.com/kroger/callback`.
   Keep the localhost one too if you still use local mode.
3. **Run it** with one of the options below. It listens on `127.0.0.1:3000` by default.
4. **Expose it over HTTPS.** OAuth clients require HTTPS, and the server trusts reverse proxies on
   loopback and private networks by default.
   - **Cloudflare Tunnel** (no open ports): route a tunnel hostname to `http://localhost:3000`.
   - **Caddy**: `kroger.example.com { reverse_proxy localhost:3000 }`. TLS is automatic.
   - **nginx or Traefik**: proxy to `localhost:3000`, forwarding `Host` and `X-Forwarded-For`.
5. **Connect a client:**
   - **claude.ai or the mobile apps:** go to *Settings → Connectors → Add custom connector* and enter
     `https://kroger.example.com/mcp`. Then follow the consent page and Kroger sign-in.
   - **Claude Code:** run `claude mcp add --transport http kroger-remote https://kroger.example.com/mcp`,
     then run `/mcp` inside Claude Code to authenticate.

### Running it

**systemd (this host).** This shares the data directory with local mode, so your existing Kroger
login is reused and becomes the owner automatically.
```sh
npm run build
cp deploy/kroger-mcp.service ~/.config/systemd/user/   # then edit the node path inside
systemctl --user daemon-reload && systemctl --user enable --now kroger-mcp
loginctl enable-linger "$USER"                          # keep running while logged out
journalctl --user -u kroger-mcp -f                       # logs
```

**Docker.** The data is kept in the `kroger-data` volume, which starts empty, so set
`KROGER_ALLOWED_PROFILE_ID` in `.env`.
```sh
docker compose up -d --build
```

**Other hosts (VPS, Fly.io, Railway, ...).** Build the `Dockerfile`, mount a persistent volume at
`/data`, and set the env vars. The platform's `PORT` is honored.

### Remote-mode settings

| Variable | Default | |
|---|---|---|
| `MCP_PUBLIC_URL` | (required) | Public origin, `https://` unless localhost, with no path |
| `MCP_HOST` / `MCP_PORT` | `127.0.0.1` / `3000` | Listen address. `PORT` also works. The Docker image uses `0.0.0.0` |
| `KROGER_ALLOWED_PROFILE_ID` | owner of the saved login | Only this Kroger account can sign in |
| `MCP_API_KEY` | (off) | Optional static bearer token (32 or more characters) for scripts and curl: `Authorization: Bearer <key>` |
| `MCP_TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Express `trust proxy` setting, so rate limits see real client IPs |
| `MCP_ALLOWED_HOSTS` | (none) | Extra accepted `Host` headers, comma-separated. The public hostname and localhost are always allowed |

Other notes:

- `GET /healthz` is unauthenticated, for health checks.
- In remote mode, `kroger_login` returns `$MCP_PUBLIC_URL/kroger/login`, which reconnects the Kroger
  account. It's only needed if Kroger's refresh token ever expires.

## Development

```sh
npm run dev         # run from source with tsx
npm test            # vitest (fetch is mocked; no network)
npm run typecheck   # type-check src and tests
npx @modelcontextprotocol/inspector node dist/index.js   # poke at tools interactively
```
