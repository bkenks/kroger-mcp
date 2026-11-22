import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Where Kroger API credentials came from. */
export type CredentialsSource = "environment" | "credentials-file";

export interface Config {
  clientId: string;
  clientSecret: string;
  credentialsSource: CredentialsSource;
  redirectUri: string;
  /** Base URL for REST endpoints, e.g. https://api.kroger.com/v1 */
  apiBase: string;
  dataDir: string;
  defaultLocationId?: string;
}

/** Absolute path of the CLI entry point (dist/index.js), for MCP client configs and messages. */
export const ENTRY_PATH = fileURLToPath(new URL("./index.js", import.meta.url));

/** Store key (in the data dir) for credentials saved by `kroger-mcp setup`. */
export const CREDENTIALS_KEY = "credentials";

export const API_BASES = {
  prod: "https://api.kroger.com/v1",
  cert: "https://api-ce.kroger.com/v1",
} as const;

// Treat empty strings (e.g. `KROGER_LOCATION_ID=` in .env) as unset.
const optional = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined));

const EnvSchema = z.object({
  KROGER_CLIENT_ID: optional,
  KROGER_CLIENT_SECRET: optional,
  KROGER_REDIRECT_URI: optional,
  KROGER_ENV: optional.pipe(z.enum(["prod", "cert"], { message: 'KROGER_ENV must be "prod" or "cert"' }).optional()),
  KROGER_LOCATION_ID: optional,
  KROGER_MCP_DATA_DIR: optional,
});

export class MissingCredentialsError extends Error {
  constructor() {
    super(
      "Kroger API credentials are not configured. Run `node " +
        ENTRY_PATH +
        " setup` in a terminal to add them, or set KROGER_CLIENT_ID and KROGER_CLIENT_SECRET.",
    );
    this.name = "MissingCredentialsError";
  }
}

/**
 * Load a .env file from the project root (next to package.json) if present.
 * MCP clients launch servers from arbitrary working directories, so the cwd is
 * also checked but the project root is preferred. Existing env vars win.
 * Returns the path loaded, if any.
 */
export function loadDotEnv(): string | undefined {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  for (const path of [join(projectRoot, ".env"), join(process.cwd(), ".env")]) {
    if (existsSync(path)) {
      process.loadEnvFile(path);
      return path;
    }
  }
  return undefined;
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return env.KROGER_MCP_DATA_DIR?.trim() || join(configHome, "kroger-mcp");
}

/** Read credentials saved by `kroger-mcp setup` (sync, since config loads at startup). */
export function readCredentialsFile(dataDir: string): { clientId: string; clientSecret: string } | undefined {
  try {
    const data = JSON.parse(readFileSync(join(dataDir, `${CREDENTIALS_KEY}.json`), "utf8"));
    if (typeof data?.clientId === "string" && typeof data?.clientSecret === "string" && data.clientId && data.clientSecret) {
      return { clientId: data.clientId, clientSecret: data.clientSecret };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Could not read Kroger credentials file in ${dataDir}: ${(err as Error).message}`);
    }
  }
  return undefined;
}

/**
 * Credentials come from KROGER_CLIENT_ID/KROGER_CLIENT_SECRET (environment or .env) if both are set,
 * otherwise from the credentials file written by `kroger-mcp setup`.
 * @param opts.redirectUri Overrides KROGER_REDIRECT_URI; HTTP mode derives it from MCP_PUBLIC_URL.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { redirectUri?: string } = {}): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid Kroger MCP configuration: ${parsed.error.issues.map((i) => i.message).join("; ")}.`);
  }
  const e = parsed.data;
  const dataDir = resolveDataDir(env);

  let credentials: { clientId: string; clientSecret: string; credentialsSource: CredentialsSource } | undefined;
  if (e.KROGER_CLIENT_ID && e.KROGER_CLIENT_SECRET) {
    credentials = { clientId: e.KROGER_CLIENT_ID, clientSecret: e.KROGER_CLIENT_SECRET, credentialsSource: "environment" };
  } else {
    const saved = readCredentialsFile(dataDir);
    if (saved) credentials = { ...saved, credentialsSource: "credentials-file" };
  }
  if (!credentials) throw new MissingCredentialsError();

  return {
    ...credentials,
    redirectUri: opts.redirectUri ?? e.KROGER_REDIRECT_URI ?? "http://localhost:8000/callback",
    apiBase: API_BASES[e.KROGER_ENV ?? "prod"],
    dataDir,
    defaultLocationId: e.KROGER_LOCATION_ID,
  };
}

export interface HttpConfig {
  /** Public origin clients reach the server at, e.g. https://kroger.example.com */
  publicUrl: URL;
  /** Full URL of the MCP endpoint (publicUrl + /mcp). */
  mcpUrl: URL;
  /** Kroger OAuth redirect handled by this server; must be registered on the Kroger app. */
  krogerRedirectUri: string;
  host: string;
  port: number;
  /** Optional static bearer token accepted in addition to OAuth (for scripts and curl). */
  apiKey?: string;
  /** Only this Kroger account may authorize clients. Falls back to the saved login's owner. */
  allowedProfileId?: string;
  /** Express "trust proxy" setting so rate limits see real client IPs behind a reverse proxy. */
  trustProxy: boolean | number | string;
  /** Host headers accepted (DNS-rebinding protection). */
  allowedHosts: string[];
}

const HttpEnvSchema = z.object({
  MCP_PUBLIC_URL: z
    .string({ error: "MCP_PUBLIC_URL is required for serve mode (e.g. https://kroger.example.com)" })
    .trim()
    .pipe(z.url({ message: "MCP_PUBLIC_URL must be a URL like https://kroger.example.com" })),
  MCP_HOST: optional,
  MCP_PORT: optional,
  PORT: optional,
  MCP_API_KEY: optional.pipe(
    z.string().min(32, "MCP_API_KEY must be at least 32 characters (try: openssl rand -hex 32)").optional(),
  ),
  KROGER_ALLOWED_PROFILE_ID: optional,
  MCP_TRUST_PROXY: optional,
  MCP_ALLOWED_HOSTS: optional,
});

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const parsed = HttpEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid serve configuration: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const e = parsed.data;
  const publicUrl = new URL(e.MCP_PUBLIC_URL);
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error("MCP_PUBLIC_URL must be just an origin with no path, e.g. https://kroger.example.com");
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !isLocal) {
    throw new Error("MCP_PUBLIC_URL must use https:// (OAuth clients require it), except for localhost testing.");
  }
  const port = Number(e.MCP_PORT ?? e.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${e.MCP_PORT ?? e.PORT}`);

  return {
    publicUrl,
    mcpUrl: new URL("/mcp", publicUrl),
    krogerRedirectUri: new URL("/kroger/callback", publicUrl).href,
    host: e.MCP_HOST ?? "127.0.0.1",
    port,
    apiKey: e.MCP_API_KEY,
    allowedProfileId: e.KROGER_ALLOWED_PROFILE_ID,
    trustProxy: parseTrustProxy(e.MCP_TRUST_PROXY),
    allowedHosts: [
      publicUrl.hostname,
      "localhost",
      "127.0.0.1",
      ...(e.MCP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? []),
    ],
  };
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  // Default trusts proxies on loopback and private networks (same host, Docker, LAN), not the internet.
  if (value === undefined) return "loopback, linklocal, uniquelocal";
  if (value === "true") return true;
  if (value === "false") return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}
