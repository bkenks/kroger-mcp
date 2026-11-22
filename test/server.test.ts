import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createDeps, createServer } from "../src/server.js";
import { jsonResponse, mockFetch, testConfig, tokenResponse } from "./helpers.js";

async function connect(routes: Parameters<typeof mockFetch>[0], configOverrides = {}) {
  const mock = mockFetch({ "POST /connect/oauth2/token": tokenResponse("t"), ...routes });
  const deps = createDeps(testConfig(configOverrides), mock.fetchFn);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    const text = res.content[0].text;
    return { isError: !!res.isError, text, data: res.isError ? undefined : JSON.parse(text) };
  };
  return { client, call, deps, ...mock };
}

const location = {
  locationId: "01400513",
  name: "Kroger On the Rhine",
  chain: "KROGER",
  address: { addressLine1: "100 E Court St", city: "Cincinnati", state: "OH", zipCode: "45202" },
};

describe("MCP server", () => {
  it("exposes the expected tools", async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "add_to_cart",
        "auth_status",
        "get_location",
        "get_preferred_location",
        "get_product",
        "get_profile",
        "kroger_login",
        "kroger_logout",
        "list_chains",
        "list_departments",
        "search_locations",
        "search_products",
        "set_preferred_location",
      ].sort(),
    );
  });

  it("uses the saved preferred location for product searches", async () => {
    const { call, callsTo } = await connect({
      "GET /locations/01400513": jsonResponse({ data: location }),
      "GET /products": jsonResponse({ data: [{ productId: "1", items: [{ price: { regular: 1.5 } }] }] }),
    });

    const saved = await call("set_preferred_location", { locationId: "01400513" });
    expect(saved.data.location.name).toBe("Kroger On the Rhine");
    expect((await call("get_preferred_location")).data).toMatchObject({ locationId: "01400513", source: "saved" });

    const res = await call("search_products", { term: "milk" });
    expect(res.data.locationId).toBe("01400513");
    expect(res.data.products[0].price).toEqual({ regular: 1.5 });
    expect(callsTo("GET /products")[0].url.searchParams.get("filter.locationId")).toBe("01400513");
  });

  it("falls back to KROGER_LOCATION_ID and notes when no store is set", async () => {
    const withEnv = await connect(
      { "GET /products": jsonResponse({ data: [] }) },
      { defaultLocationId: "01400999" },
    );
    expect((await withEnv.call("search_products", { term: "milk" })).data.locationId).toBe("01400999");

    const without = await connect({ "GET /products": jsonResponse({ data: [] }) });
    expect((await without.call("search_products", { term: "milk" })).data.note).toMatch(/No store selected/);
  });

  it("validates inputs", async () => {
    const { call } = await connect({});
    expect((await call("search_products", {})).text).toMatch(/at least one of term, brand, or productIds/);
    expect((await call("search_locations", {})).text).toMatch(/zipCode, or both lat and lon/);
    expect((await call("get_location", { locationId: "abc" })).isError).toBe(true);
  });

  it("tells the model to log in when cart tools are used without auth", async () => {
    const { call, calls } = await connect({});
    const res = await call("add_to_cart", { items: [{ upc: "0001111041700" }] });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/kroger_login/);
    expect(calls).toHaveLength(0);
  });

  it("adds to cart when logged in", async () => {
    const { call, deps, callsTo } = await connect({ "PUT /cart/add": () => new Response(null, { status: 204 }) });
    // Seed a saved login.
    const { JsonStore } = await import("../src/store.js");
    await new JsonStore(deps.config.dataDir).write("tokens", {
      accessToken: "u",
      refreshToken: "r",
      expiresAt: Date.now() + 3600_000,
    });

    const res = await call("add_to_cart", { items: [{ upc: "0001111041700", quantity: 2, modality: "DELIVERY" }] });
    expect(res.isError).toBe(false);
    expect(JSON.parse(callsTo("PUT /cart/add")[0].body!).items).toEqual([
      { upc: "0001111041700", quantity: 2, modality: "DELIVERY" },
    ]);
  });
});
