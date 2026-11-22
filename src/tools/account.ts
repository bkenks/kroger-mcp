import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Deps, json } from "./shared.js";

export function registerAccountTools(server: McpServer, { client, tokens, login }: Deps) {
  server.registerTool(
    "kroger_login",
    {
      title: "Log in to Kroger",
      description:
        "Start the Kroger account login needed for add_to_cart and get_profile. Returns a URL the user must open " +
        "in a browser; after they approve, the login completes automatically. Then call auth_status to confirm.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => json(await login.start()),
  );

  server.registerTool(
    "auth_status",
    {
      title: "Kroger login status",
      description: "Check whether a Kroger account is logged in (needed for cart and profile tools).",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => json(await tokens.userStatus()),
  );

  server.registerTool(
    "kroger_logout",
    {
      title: "Log out of Kroger",
      description: "Delete the saved Kroger account tokens from this machine.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      await tokens.logout();
      return json({ loggedOut: true });
    },
  );

  server.registerTool(
    "add_to_cart",
    {
      title: "Add items to Kroger cart",
      description:
        "Add products to the logged-in user's Kroger cart by UPC (from search_products). The Kroger API can only " +
        "add items; it cannot read or remove cart contents. Requires kroger_login.",
      inputSchema: {
        items: z
          .array(
            z.object({
              upc: z.string().regex(/^\d{1,14}$/, "UPC must be digits (use the upc from search_products)"),
              quantity: z.number().int().min(1).max(99).default(1),
              modality: z
                .enum(["PICKUP", "DELIVERY"])
                .default("PICKUP")
                .describe("How the order will be fulfilled"),
            }),
          )
          .min(1)
          .max(50),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ items }) => {
      await client.addToCart(items);
      return json({
        added: items,
        note: "Items were added to the user's Kroger cart. Review or check out at https://www.kroger.com/cart",
      });
    },
  );

  server.registerTool(
    "get_profile",
    {
      title: "Get Kroger profile",
      description: "Get the logged-in Kroger account's profile ID. Requires kroger_login.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => json((await client.getProfile()).data),
  );
}
