import type { KrogerHours, KrogerLocation, KrogerProduct, Weekday } from "./types.js";

const KROGER_WEB = "https://www.kroger.com";
const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** Compact product view: drops images and nested noise, surfaces price/stock/aisle. */
export function formatProduct(p: KrogerProduct, opts: { includeImage?: boolean } = {}) {
  const item = p.items?.[0];
  const price = item?.price;
  // Kroger returns promo: 0 when there is no sale price.
  const promo = price?.promo && price.promo > 0 && price.promo !== price.regular ? price.promo : undefined;
  const aisle = p.aisleLocations?.[0];

  return compact({
    productId: p.productId,
    upc: p.upc ?? p.productId,
    description: p.description,
    brand: p.brand,
    size: item?.size,
    soldBy: item?.soldBy,
    categories: p.categories,
    price: price?.regular !== undefined ? compact({ regular: price.regular, sale: promo }) : undefined,
    stockLevel: item?.inventory?.stockLevel,
    fulfillment: item?.fulfillment
      ? Object.entries(item.fulfillment)
          .filter(([, available]) => available)
          .map(([mode]) => mode)
      : undefined,
    aisle: aisle?.description ?? (aisle?.number ? `Aisle ${aisle.number}` : undefined),
    url: p.productPageURI ? KROGER_WEB + p.productPageURI : undefined,
    image: opts.includeImage ? pickImage(p) : undefined,
  });
}

/** Compact location view; `detailed` adds full weekly hours and departments. */
export function formatLocation(l: KrogerLocation, opts: { detailed?: boolean } = {}) {
  const a = l.address;
  const address = a
    ? [a.addressLine1, a.addressLine2, a.city, [a.state, a.zipCode].filter(Boolean).join(" ")]
        .filter(Boolean)
        .join(", ")
    : undefined;

  return compact({
    locationId: l.locationId,
    name: l.name,
    chain: l.chain,
    address,
    phone: l.phone,
    hours: opts.detailed ? formatWeek(l.hours) : todayHours(l.hours),
    timezone: opts.detailed ? l.hours?.timezone : undefined,
    departments: opts.detailed
      ? l.departments?.map((d) => d.name).filter((n): n is string => !!n)
      : undefined,
    coordinates:
      opts.detailed && l.geolocation?.latitude !== undefined
        ? { lat: l.geolocation.latitude, lon: l.geolocation.longitude }
        : undefined,
  });
}

function formatHours(h?: KrogerHours): string | undefined {
  if (!h) return undefined;
  if (h.open24) return "open 24 hours";
  if (h.open && h.close) return `${h.open}–${h.close}`;
  return undefined;
}

function formatWeek(hours: KrogerLocation["hours"]): Record<string, string> | string | undefined {
  if (!hours) return undefined;
  if (hours.open24) return "open 24 hours";
  const week: Record<string, string> = {};
  for (const day of WEEKDAYS) {
    const h = formatHours(hours[day]);
    if (h) week[day] = h;
  }
  return Object.keys(week).length ? week : undefined;
}

function todayHours(hours: KrogerLocation["hours"]): string | undefined {
  if (!hours) return undefined;
  if (hours.open24) return "open 24 hours";
  let day: Weekday;
  try {
    const name = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: hours.timezone })
      .format(new Date())
      .toLowerCase();
    day = name as Weekday;
  } catch {
    // Unknown timezone string; fall back to the server's local day.
    day = WEEKDAYS[(new Date().getDay() + 6) % 7];
  }
  const h = formatHours(hours[day]);
  return h ? `today: ${h}` : undefined;
}

function pickImage(p: KrogerProduct): string | undefined {
  const image = p.images?.find((i) => i.featured) ?? p.images?.find((i) => i.perspective === "front") ?? p.images?.[0];
  const sizes = image?.sizes ?? [];
  return (sizes.find((s) => s.size === "medium") ?? sizes.find((s) => s.size === "large") ?? sizes[0])?.url;
}

/** Remove undefined fields and empty arrays so the JSON stays small. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)),
  ) as Partial<T>;
}
