import type { FetchFn, TokenManager } from "./auth.js";
import type { Config } from "./config.js";
import { KrogerApiError, describeErrorBody } from "./errors.js";
import type { KrogerChain, KrogerDepartment, KrogerLocation, KrogerProduct } from "./types.js";

type Query = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  /** Which token to send; `{ token }` uses an explicit user token without refresh. */
  auth: "app" | "user" | { token: string };
  query?: Query;
  body?: unknown;
}

export interface ListResponse<T> {
  data: T[];
  meta?: { pagination?: { start?: number; limit?: number; total?: number } };
}

export interface ProductSearchParams {
  term?: string;
  locationId?: string;
  productIds?: string[];
  brand?: string;
  fulfillment?: "ais" | "csp" | "dth" | "sth";
  start?: number;
  limit?: number;
}

export interface LocationSearchParams {
  zipCode?: string;
  latLong?: { lat: number; lon: number };
  radiusInMiles?: number;
  chain?: string;
  department?: string;
  limit?: number;
}

export type Modality = "PICKUP" | "DELIVERY";

export interface CartItem {
  upc: string;
  quantity: number;
  modality?: Modality;
}

export class KrogerClient {
  constructor(
    private readonly config: Config,
    private readonly tokens: TokenManager,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  searchProducts(p: ProductSearchParams) {
    return this.request<ListResponse<KrogerProduct>>("GET", "/products", {
      auth: "app",
      query: {
        "filter.term": p.term,
        "filter.locationId": p.locationId,
        "filter.productId": p.productIds?.join(","),
        "filter.brand": p.brand,
        "filter.fulfillment": p.fulfillment,
        "filter.start": p.start,
        "filter.limit": p.limit,
      },
    });
  }

  getProduct(productId: string, locationId?: string) {
    return this.request<{ data: KrogerProduct }>("GET", `/products/${encodeURIComponent(productId)}`, {
      auth: "app",
      query: { "filter.locationId": locationId },
    });
  }

  searchLocations(p: LocationSearchParams) {
    return this.request<ListResponse<KrogerLocation>>("GET", "/locations", {
      auth: "app",
      query: {
        "filter.zipCode.near": p.zipCode,
        "filter.latLong.near": p.latLong && `${p.latLong.lat},${p.latLong.lon}`,
        "filter.radiusInMiles": p.radiusInMiles,
        "filter.chain": p.chain,
        "filter.department": p.department,
        "filter.limit": p.limit,
      },
    });
  }

  getLocation(locationId: string) {
    return this.request<{ data: KrogerLocation }>("GET", `/locations/${encodeURIComponent(locationId)}`, {
      auth: "app",
    });
  }

  listChains() {
    return this.request<ListResponse<KrogerChain>>("GET", "/chains", { auth: "app" });
  }

  listDepartments() {
    return this.request<ListResponse<KrogerDepartment>>("GET", "/departments", { auth: "app" });
  }

  async addToCart(items: CartItem[]): Promise<void> {
    await this.request<void>("PUT", "/cart/add", {
      auth: "user",
      body: { items: items.map((i) => ({ upc: i.upc, quantity: i.quantity, modality: i.modality ?? "PICKUP" })) },
    });
  }

  /** Profile of the saved login, or of `accessToken` if given (to identify a login before saving it). */
  getProfile(accessToken?: string) {
    return this.request<{ data: { id: string } }>("GET", "/identity/profile", {
      auth: accessToken ? { token: accessToken } : "user",
    });
  }

  async request<T>(method: string, path: string, opts: RequestOptions): Promise<T> {
    const url = new URL(this.config.apiBase + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }

    const send = async (forceRefresh: boolean) => {
      const token =
        typeof opts.auth === "object"
          ? opts.auth.token
          : opts.auth === "app"
            ? await this.tokens.getAppToken(forceRefresh)
            : await this.tokens.getUserToken(forceRefresh);
      return this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(opts.body !== undefined && { "Content-Type": "application/json" }),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    };

    let res = await send(false);
    // A 401 usually means the token was revoked or expired early; refresh once and retry.
    if (res.status === 401 && typeof opts.auth !== "object") res = await send(true);

    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!res.ok) {
      const detail = describeErrorBody(body) ?? res.statusText;
      let message = `Kroger API ${method} ${path} failed with ${res.status}: ${detail}`;
      if (res.status === 429) message += " (rate limit reached; Kroger limits calls per day per endpoint)";
      if (res.status === 403 && opts.auth !== "app") {
        message += " (the login may be missing a required scope; try kroger_login again)";
      }
      throw new KrogerApiError(res.status, message, body);
    }
    return body as T;
  }
}
