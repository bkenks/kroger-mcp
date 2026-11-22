import { describe, expect, it } from "vitest";
import { formatLocation, formatProduct } from "../src/format.js";

describe("formatProduct", () => {
  const base = {
    productId: "0001111041700",
    upc: "0001111041700",
    description: "Kroger 2% Milk",
    brand: "Kroger",
    productPageURI: "/p/milk/0001111041700",
    aisleLocations: [{ description: "DAIRY", number: "12" }],
    images: [{ perspective: "front", featured: true, sizes: [{ size: "large", url: "L" }, { size: "medium", url: "M" }] }],
  };

  it("ignores Kroger's promo: 0 placeholder", () => {
    const p = formatProduct({ ...base, items: [{ size: "1 gal", price: { regular: 3.49, promo: 0 } }] });
    expect(p.price).toEqual({ regular: 3.49 });
  });

  it("surfaces sale price, stock, fulfillment, aisle, and url", () => {
    const p = formatProduct(
      {
        ...base,
        items: [
          {
            size: "1 gal",
            price: { regular: 3.49, promo: 2.99 },
            inventory: { stockLevel: "LOW" },
            fulfillment: { curbside: true, delivery: false, inStore: true, shipToHome: false },
          },
        ],
      },
      { includeImage: true },
    );
    expect(p).toMatchObject({
      price: { regular: 3.49, sale: 2.99 },
      stockLevel: "LOW",
      fulfillment: ["curbside", "inStore"],
      aisle: "DAIRY",
      url: "https://www.kroger.com/p/milk/0001111041700",
      image: "M",
    });
  });

  it("omits store-specific fields when there is no item data", () => {
    const p = formatProduct({ productId: "1" });
    expect(p).toEqual({ productId: "1", upc: "1" });
  });
});

describe("formatLocation", () => {
  const loc = {
    locationId: "01400513",
    name: "Kroger On the Rhine",
    chain: "KROGER",
    address: { addressLine1: "100 E Court St", city: "Cincinnati", state: "OH", zipCode: "45202" },
    hours: { timezone: "America/New_York", monday: { open: "06:00", close: "22:00" }, tuesday: { open24: true } },
    departments: [{ name: "Deli" }, { name: "Bakery" }],
  };

  it("builds a one-line address and hides details by default", () => {
    const l = formatLocation(loc);
    expect(l.address).toBe("100 E Court St, Cincinnati, OH 45202");
    expect(l.departments).toBeUndefined();
  });

  it("includes weekly hours and departments when detailed", () => {
    const l = formatLocation(loc, { detailed: true });
    expect(l.hours).toEqual({ monday: "06:00–22:00", tuesday: "open 24 hours" });
    expect(l.departments).toEqual(["Deli", "Bakery"]);
  });
});
