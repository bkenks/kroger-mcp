import { describe, expect, it } from "vitest";
import { TokenManager } from "../src/auth.js";
import { KrogerClient } from "../src/client.js";
import { KrogerApiError } from "../src/errors.js";
import { JsonStore } from "../src/store.js";
import { jsonResponse, mockFetch, testConfig, tokenResponse } from "./helpers.js";

function setup(routes: Parameters<typeof mockFetch>[0]) {
  const config = testConfig();
  const store = new JsonStore(config.dataDir);
  const mock = mockFetch({ "POST /connect/oauth2/token": [tokenResponse("t1"), tokenResponse("t2")], ...routes });
  const tokens = new TokenManager(config, store, mock.fetchFn);
  return { store, client: new KrogerClient(config, tokens, mock.fetchFn), ...mock };
}

describe("KrogerClient", () => {
  it("maps product search params to Kroger filters and omits unset ones", async () => {
    const { client, callsTo } = setup({ "GET /products": jsonResponse({ data: [] }) });
    await client.searchProducts({ term: "eggs", locationId: "01400513", productIds: ["1", "2"], limit: 5 });

    const [call] = callsTo("GET /products");
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      "filter.term": "eggs",
      "filter.locationId": "01400513",
      "filter.productId": "1,2",
      "filter.limit": "5",
    });
    expect(call.headers.authorization).toBe("Bearer t1");
  });

  it("formats lat/long location searches", async () => {
    const { client, callsTo } = setup({ "GET /locations": jsonResponse({ data: [] }) });
    await client.searchLocations({ latLong: { lat: 39.1, lon: -84.5 }, radiusInMiles: 5 });
    const params = callsTo("GET /locations")[0].url.searchParams;
    expect(params.get("filter.latLong.near")).toBe("39.1,-84.5");
    expect(params.get("filter.radiusInMiles")).toBe("5");
  });

  it("refreshes the token and retries once on 401", async () => {
    const { client, callsTo } = setup({
      "GET /chains": [jsonResponse({}, 401), jsonResponse({ data: [{ name: "KROGER" }] })],
    });
    const res = await client.listChains();
    expect(res.data[0].name).toBe("KROGER");
    const calls = callsTo("GET /chains");
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer t1", "Bearer t2"]);
  });

  it("raises KrogerApiError with the API's reason", async () => {
    const { client } = setup({
      "GET /products": jsonResponse({ errors: { reason: "Field 'term' must be at least 3 characters", code: "x" } }, 400),
    });
    const err = await client.searchProducts({ term: "ab" }).catch((e) => e);
    expect(err).toBeInstanceOf(KrogerApiError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("must be at least 3 characters");
  });

  it("adds to cart with the user token and defaults modality to PICKUP", async () => {
    const { client, store, callsTo } = setup({ "PUT /cart/add": () => new Response(null, { status: 204 }) });
    await store.write("tokens", { accessToken: "user-token", refreshToken: "r", expiresAt: Date.now() + 3600_000 });

    await client.addToCart([{ upc: "0001111041700", quantity: 2 }]);

    const [call] = callsTo("PUT /cart/add");
    expect(call.headers.authorization).toBe("Bearer user-token");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call.body!)).toEqual({ items: [{ upc: "0001111041700", quantity: 2, modality: "PICKUP" }] });
  });
});
