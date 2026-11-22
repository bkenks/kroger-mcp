import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export interface Config {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Base URL for REST endpoints, e.g. https://api.kroger.com/v1 */
  apiBase: string;
  dataDir: string;
  defaultLocationId?: string;
}

const API_BASES = {
  prod: "https://api.kroger.com/v1",
  cert: "https://api-ce.kroger.com/v1",
} as const;

// Treat empty strings (e.g. `KROGER_LOCATION_ID=` in .env) as unset.
const optional = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined));

const EnvSchema = z.object({
  KROGER_CLIENT_ID: z.string().trim().min(1, "KROGER_CLIENT_ID is required"),
  KROGER_CLIENT_SECRET: z.string().trim().min(1, "KROGER_CLIENT_SECRET is required"),
  KROGER_REDIRECT_URI: optional,
  KROGER_ENV: optional.pipe(z.enum(["prod", "cert"]).optional()),
  KROGER_LOCATION_ID: optional,
  KROGER_MCP_DATA_DIR: optional,
});

/**
 * Load a .env file from the project root (next to package.json) if present.
 * MCP clients launch servers from arbitrary working directories, so the cwd is
 * also checked but the project root is preferred. Existing env vars win.
 */
export function loadDotEnv(): void {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  for (const path of [join(projectRoot, ".env"), join(process.cwd(), ".env")]) {
    if (existsSync(path)) {
      process.loadEnvFile(path);
      return;
    }
  }
}

/**
 * @param opts.redirectUri Overrides KROGER_REDIRECT_URI; HTTP mode derives it from MCP_PUBLIC_URL.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { redirectUri?: string } = {}): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => i.message).join("; ");
    throw new Error(
      `Invalid Kroger MCP configuration: ${problems}. ` +
        "Set the variables in the environment or in a .env file (see .env.example).",
    );
  }
  const e = parsed.data;
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return {
    clientId: e.KROGER_CLIENT_ID,
    clientSecret: e.KROGER_CLIENT_SECRET,
    redirectUri: opts.redirectUri ?? e.KROGER_REDIRECT_URI ?? "http://localhost:8000/callback",
    apiBase: API_BASES[e.KROGER_ENV ?? "prod"],
    dataDir: e.KROGER_MCP_DATA_DIR ?? join(configHome, "kroger-mcp"),
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
