import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatProduct } from "../format.js";
import { type Deps, NO_LOCATION_NOTE, json } from "./shared.js";

const locationIdSchema = z
  .string()
  .regex(/^\d{8}$/, "Kroger locationIds are 8 digits")
  .optional()
  .describe("Store to price/stock against. Defaults to the preferred location.");

export function registerProductTools(server: McpServer, { client, prefs }: Deps) {
  server.registerTool(
    "search_products",
    {
      title: "Search Kroger products",
      description:
        "Search the Kroger catalog by keyword, brand, or product IDs. Prices, stock level, and aisle are " +
        "included when a store is selected (locationId or preferred location). Returns UPCs usable with add_to_cart.",
      inputSchema: {
        term: z.string().min(3).max(100).optional().describe("Search keywords, e.g. 'organic whole milk' (min 3 chars)"),
        brand: z.string().optional().describe("Filter by brand name, e.g. 'Kroger' or 'Simple Truth'"),
        productIds: z
          .array(z.string())
          .max(50)
          .optional()
          .describe("Look up specific products by productId/UPC"),
        locationId: locationIdSchema,
        fulfillment: z
          .enum(["ais", "csp", "dth", "sth"])
          .optional()
          .describe("Only products available via: ais=in store, csp=curbside pickup, dth=delivery, sth=ship to home"),
        limit: z.number().int().min(1).max(50).default(10).describe("Results per page (max 50)"),
        start: z.number().int().min(1).max(250).optional().describe("Number of results to skip, for paging"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      if (!args.term && !args.brand && !args.productIds?.length) {
        throw new Error("Provide at least one of term, brand, or productIds.");
      }
      const locationId = args.locationId ?? (await prefs.getLocationId());
      const res = await client.searchProducts({ ...args, locationId });
      return json({
        locationId,
        ...(!locationId && { note: NO_LOCATION_NOTE }),
        pagination: res.meta?.pagination,
        products: res.data.map((p) => formatProduct(p)),
      });
    },
  );

  server.registerTool(
    "get_product",
    {
      title: "Get Kroger product details",
      description: "Get details for one product by productId/UPC, including price, stock, aisle, and an image URL.",
      inputSchema: {
        productId: z.string().min(1).describe("13-digit productId/UPC from search_products"),
        locationId: locationIdSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ productId, locationId: given }) => {
      const locationId = given ?? (await prefs.getLocationId());
      const res = await client.getProduct(productId, locationId);
      return json({
        locationId,
        ...(!locationId && { note: NO_LOCATION_NOTE }),
        product: formatProduct(res.data, { includeImage: true }),
      });
    },
  );
}
