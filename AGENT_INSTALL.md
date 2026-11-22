# Kroger MCP: setup guide for AI agents

You are an AI agent helping a user install and set up the
[Kroger MCP server](https://github.com/bkenks/kroger-mcp). It lets you search Kroger-family stores
and products, with local prices and stock, and add items to the user's Kroger cart.

Work through the steps in order. Briefly explain what each step does, since the user may not be
technical. When a step needs the user, for example to use their browser or enter a secret, stop and
wait for them.

## Ground rules

- **Never collect the Kroger Client Secret in chat.** The user enters it in the interactive `setup`
  command, in their own terminal, with hidden input. If they paste it into the chat anyway:
  - don't repeat it or write it anywhere yourself;
  - still have them run `setup`;
  - mention that they can regenerate the secret in the Kroger developer portal if they're concerned.
- **Never put credentials in MCP client configs, shell profiles, or the repository.** The server reads
  them from its own private file (`~/.config/kroger-mcp/credentials.json`, mode `0600`).
- **Don't run `setup` or `auth` yourself.** They need a real terminal and a browser. Give the user the
  exact command to run in a separate terminal window on the machine where the server is installed.
- **Ask before editing the user's MCP client configuration**, and show them the change.
- **Use `status` to check progress at any time.** It prints JSON with the exact install paths, what's
  configured, and a `nextSteps` list. It never prints secrets.

## Step 1: Look for an existing install

The default install location is `~/.local/share/kroger-mcp`, or `$KROGER_MCP_HOME` if set. Run:

```sh
node ~/.local/share/kroger-mcp/dist/index.js status
```

- **If it prints JSON,** it's installed. Go to Step 3. To update an old install first, re-run the
  installer from Step 2.
- **If the user cloned the repo somewhere else,** ask where. The entry point is
  `<repo>/dist/index.js`. If `dist/` is missing, run `npm ci --ignore-scripts && npm run build` there.
- **Otherwise,** continue to Step 2.

## Step 2: Install

You need **Node.js 22 or newer**, **npm**, and **git**. Check with `node --version`. If Node is
missing or too old, help the user install it from https://nodejs.org or their package manager.

**macOS or Linux:**

```sh
curl -fsSL https://raw.githubusercontent.com/bkenks/kroger-mcp/main/install.sh | bash
```

The installer clones the repo to `~/.local/share/kroger-mcp`, or updates an existing copy, then
builds it. Its output ends with `KROGER_MCP_ENTRY=` and `KROGER_MCP_NODE=` lines. If the user
prefers, download `install.sh` and review it before running it.

**Windows, or a manual install anywhere:**

```sh
git clone --depth 1 https://github.com/bkenks/kroger-mcp.git ~/.local/share/kroger-mcp
cd ~/.local/share/kroger-mcp
npm ci --ignore-scripts
npm run build
```

Then run `status` (Step 1) and note `install.mcpServer`. That's the exact command and arguments to
register in Step 5.

## Step 3: Create a Kroger developer app (the user does this in a browser)

Skip this step if `status` shows `"credentials": { "configured": true, "valid": true }`.

Walk the user through it:

1. Go to **https://developer.kroger.com**, then sign in or create a developer account.
2. Create a new **application**, under *Manage → Applications*, for the **Production** environment.
3. Give it access to these APIs: **Products**, **Locations**, **Cart**, and **Identity**. The portal's
   exact wording may differ slightly.
4. Add this **redirect URI**, exactly: `http://localhost:8000/callback`. If `status` shows a different
   `redirectUri`, use that one instead.
5. Save the app and keep its **Client ID** and **Client Secret** handy. **Don't paste them into chat.**

## Step 4: The user runs `setup` in their own terminal

Give the user the `setup` command from `status`'s `nextSteps`. It looks like this:

```sh
"/path/to/node" "/home/<user>/.local/share/kroger-mcp/dist/index.js" setup
```

Explain what will happen:

1. It asks for the **Client ID** and the **Client Secret** (the secret stays hidden while typing),
   checks them with Kroger, and saves them privately.
2. It offers to **log in to Kroger**, which is needed for adding to the cart. A browser opens, and they
   sign in with their **normal Kroger shopping account** and approve access.
3. It offers to choose a **default store** by ZIP code, so results include local prices and stock.

**If the server runs on a remote machine** (the user connects over SSH), the Kroger login redirects
their browser to `localhost:8000`, which is their own computer. They need to forward that port before
logging in, for example `ssh -L 8000:localhost:8000 user@host`. They can also skip the login during
`setup` and run the `auth` command later, once the tunnel is up.

When they say they're done, run `status` again. Expect `ready.searchTools: true` and, if they logged
in, `ready.cartTools: true`.

## Step 5: Register the server with the user's MCP client

Use `install.mcpServer` from `status`:

- **command:** the absolute node path;
- **args:** the absolute path to `dist/index.js`;
- **name:** `kroger`;
- **transport:** stdio.

No environment variables are needed, and none should be added.

Typical ways to register it. If you know your own client's mechanism better, use that.

| Client | How |
|---|---|
| Claude Code | `claude mcp add --scope user kroger -- "<command>" "<args[0]>"`, then check with `claude mcp get kroger` |
| Claude Desktop | Add `"kroger": {"command": "<command>", "args": ["<args[0]>"]}` under `mcpServers` in `claude_desktop_config.json`. On macOS it's in `~/Library/Application Support/Claude/`; on Windows, in `%APPDATA%\Claude\`. Fully quit and reopen the app. |
| Cursor | Same `mcpServers` entry in `~/.cursor/mcp.json` |
| Windsurf | Same `mcpServers` entry in `~/.codeium/windsurf/mcp_config.json` |
| VS Code (Copilot) | In `mcp.json`: `"servers": {"kroger": {"type": "stdio", "command": "<command>", "args": ["<args[0]>"]}}`. Or use the *MCP: Add Server* command. |
| OpenAI Codex CLI | `codex mcp add kroger -- "<command>" "<args[0]>"`, or a `[mcp_servers.kroger]` table with `command` and `args` in `~/.codex/config.toml` |
| Gemini CLI | Same `mcpServers` entry in `~/.gemini/settings.json` |

Tell the user to restart or reload their client so it picks up the server. The tools usually aren't
available until a new session starts.

If `status` reports `install.nodeFromVersionManager: true` (mise, nvm, asdf, fnm, or volta), warn the
user: the node path may change when they upgrade Node. After an upgrade they should re-run `status`
and update this entry.

## Step 6: Try it

In a new session, try:

- "Find Kroger stores near 45202 and make the closest one my default store." This uses
  `search_locations` and `set_preferred_location`.
- "How much is a gallon of milk at my store?" This uses `search_products`.
- "Add a dozen eggs to my Kroger cart for pickup." This uses `add_to_cart` and needs the Kroger login.

Explain the API's limits: it can **add** items to the cart but can't view or remove them, place
orders, or pick pickup times. The user reviews the cart and checks out in the Kroger app or on
kroger.com.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `redirect_uri did not match` / `invalid redirect_uri` | Register the exact redirect URI from `status` on the Kroger app, then retry. |
| Login times out, or the browser can't connect to `localhost:8000` after approving | The browser is on a different machine. Set up the SSH port forward (Step 4) and run the `auth` command again. |
| `Port 8000 is already in use` | Another program is using port 8000. Pick another port: register `http://localhost:<port>/callback` on the Kroger app and set `KROGER_REDIRECT_URI` to it in `~/.local/share/kroger-mcp/.env`. Not secret; one line. |
| Credentials rejected (401) | Have the user re-run `setup` and re-enter the Client ID and Secret. |
| The client says the server failed to start | Run the `install.mcpServer` command yourself to see the error. A common cause is a node path that changed after a Node upgrade; re-run `status` and update the client config. |
| Cart tools say "Not logged in" | Have the user run the `auth` command (shown in `status` `nextSteps`). |

**Updating:** re-run the installer, then restart the MCP client.

**Uninstalling:**
1. Remove the `kroger` entry from the client.
2. Delete `~/.local/share/kroger-mcp`.
3. Delete `~/.config/kroger-mcp`, which holds the credentials, the Kroger login, and the preferences.

**Always-on remote server** (to use it from claude.ai or the phone apps): see "Remote mode" in the
[README](https://github.com/bkenks/kroger-mcp#remote-mode-always-on-http). It needs a public HTTPS
hostname, so treat it as a separate, more advanced setup.
