import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatLocation } from "../format.js";
import { type Deps, json } from "./shared.js";

export function registerLocationTools(server: McpServer, { client, prefs }: Deps) {
  server.registerTool(
    "search_locations",
    {
      title: "Find Kroger stores",
      description:
        "Find Kroger-family stores (Kroger, Ralphs, Fred Meyer, King Soopers, Harris Teeter, etc.) near a ZIP code " +
        "or coordinates. Use the returned locationId with set_preferred_location or product tools.",
      inputSchema: {
        zipCode: z.string().regex(/^\d{5}$/, "5-digit ZIP code").optional(),
        lat: z.number().min(-90).max(90).optional().describe("Latitude (use with lon instead of zipCode)"),
        lon: z.number().min(-180).max(180).optional().describe("Longitude"),
        radiusMiles: z.number().int().min(1).max(100).default(10),
        chain: z.string().optional().describe("Filter by chain name, e.g. 'KROGER' or 'RALPHS' (see list_chains)"),
        department: z.string().optional().describe("Only stores with this departmentId (see list_departments)"),
        limit: z.number().int().min(1).max(200).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ zipCode, lat, lon, radiusMiles, chain, department, limit }) => {
      const hasCoords = lat !== undefined && lon !== undefined;
      if (!zipCode && !hasCoords) throw new Error("Provide zipCode, or both lat and lon.");
      const res = await client.searchLocations({
        zipCode,
        latLong: !zipCode && hasCoords ? { lat, lon } : undefined,
        radiusInMiles: radiusMiles,
        chain,
        department,
        limit,
      });
      return json({ locations: res.data.map((l) => formatLocation(l)) });
    },
  );

  server.registerTool(
    "get_location",
    {
      title: "Get Kroger store details",
      description: "Get a store's address, phone, weekly hours, and departments.",
      inputSchema: { locationId: z.string().regex(/^\d{8}$/, "Kroger locationIds are 8 digits") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ locationId }) => {
      const res = await client.getLocation(locationId);
      return json(formatLocation(res.data, { detailed: true }));
    },
  );

  server.registerTool(
    "list_chains",
    {
      title: "List Kroger chains",
      description: "List the grocery chains (banners) in the Kroger family, for filtering search_locations.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const res = await client.listChains();
      return json(res.data.map((c) => c.name));
    },
  );

  server.registerTool(
    "list_departments",
    {
      title: "List store departments",
      description: "List departments (pharmacy, deli, fuel, etc.) and their IDs, for filtering search_locations.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const res = await client.listDepartments();
      return json(res.data.map((d) => ({ departmentId: d.departmentId, name: d.name })));
    },
  );

  server.registerTool(
    "set_preferred_location",
    {
      title: "Set preferred store",
      description:
        "Save a store as the default for product prices, stock, and aisles. Persists across sessions.",
      inputSchema: { locationId: z.string().regex(/^\d{8}$/, "Kroger locationIds are 8 digits") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ locationId }) => {
      // Validate the ID and capture a friendly name before saving.
      const store = formatLocation((await client.getLocation(locationId)).data);
      await prefs.setLocation({ locationId, name: store.name, address: store.address });
      return json({ saved: true, location: store });
    },
  );

  server.registerTool(
    "get_preferred_location",
    {
      title: "Get preferred store",
      description: "Show the store currently used by default for prices and stock, if any.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => json((await prefs.getLocation()) ?? { location: null, note: "No preferred store set." }),
  );
}
