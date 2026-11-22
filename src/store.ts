import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Tiny JSON file store for tokens and preferences. Files are private to the
 * current user (0600) since they hold OAuth refresh tokens.
 */
export class JsonStore {
  constructor(private readonly dir: string) {}

  async read<T>(name: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.path(name), "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async write(name: string, data: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies on create; keep a pre-existing data dir private too (best effort).
    await chmod(this.dir, 0o700).catch(() => {});
    const path = this.path(name);
    await writeFile(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    // writeFile's mode only applies on create; tighten pre-existing files too.
    await chmod(path, 0o600);
  }

  async delete(name: string): Promise<void> {
    await rm(this.path(name), { force: true });
  }

  private path(name: string): string {
    return join(this.dir, `${name}.json`);
  }
}
