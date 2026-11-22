// Partial shapes of Kroger Public API responses; only fields we read are typed.

export interface KrogerPrice {
  regular?: number;
  promo?: number;
  regularPerUnitEstimate?: number;
  promoPerUnitEstimate?: number;
}

export interface KrogerProductItem {
  itemId?: string;
  size?: string;
  soldBy?: string;
  price?: KrogerPrice;
  nationalPrice?: KrogerPrice;
  inventory?: { stockLevel?: string };
  fulfillment?: { curbside?: boolean; delivery?: boolean; inStore?: boolean; shipToHome?: boolean };
}

export interface KrogerAisleLocation {
  description?: string;
  number?: string;
  side?: string;
  shelfNumber?: string;
  bayNumber?: string;
}

export interface KrogerProduct {
  productId: string;
  upc?: string;
  description?: string;
  brand?: string;
  categories?: string[];
  countryOrigin?: string;
  temperature?: { indicator?: string };
  productPageURI?: string;
  aisleLocations?: KrogerAisleLocation[];
  items?: KrogerProductItem[];
  images?: Array<{ perspective?: string; featured?: boolean; sizes?: Array<{ size?: string; url?: string }> }>;
}

export interface KrogerHours {
  open?: string;
  close?: string;
  open24?: boolean;
}

export interface KrogerLocation {
  locationId: string;
  storeNumber?: string;
  divisionNumber?: string;
  chain?: string;
  name?: string;
  phone?: string;
  address?: {
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    county?: string;
  };
  geolocation?: { latitude?: number; longitude?: number };
  hours?: { timezone?: string; open24?: boolean } & Partial<Record<Weekday, KrogerHours>>;
  departments?: Array<{
    departmentId?: string;
    name?: string;
    phone?: string;
    hours?: { open24?: boolean } & Partial<Record<Weekday, KrogerHours>>;
  }>;
}

export type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export interface KrogerChain {
  name: string;
  divisionNumbers?: string[];
}

export interface KrogerDepartment {
  departmentId: string;
  name: string;
}
