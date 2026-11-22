import type { JsonStore } from "./store.js";

export interface PreferredLocation {
  locationId: string;
  name?: string;
  address?: string;
}

interface PreferencesFile {
  location?: PreferredLocation;
}

const KEY = "preferences";

/** Persisted user preferences; currently just the store used for prices and stock. */
export class Preferences {
  constructor(
    private readonly store: JsonStore,
    private readonly defaultLocationId?: string,
  ) {}

  async getLocation(): Promise<(PreferredLocation & { source: "saved" | "env" }) | undefined> {
    const saved = (await this.store.read<PreferencesFile>(KEY))?.location;
    if (saved) return { ...saved, source: "saved" };
    if (this.defaultLocationId) return { locationId: this.defaultLocationId, source: "env" };
    return undefined;
  }

  async getLocationId(): Promise<string | undefined> {
    return (await this.getLocation())?.locationId;
  }

  async setLocation(location: PreferredLocation): Promise<void> {
    const current = (await this.store.read<PreferencesFile>(KEY)) ?? {};
    await this.store.write(KEY, { ...current, location });
  }
}
