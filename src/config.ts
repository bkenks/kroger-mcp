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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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
    redirectUri: e.KROGER_REDIRECT_URI ?? "http://localhost:8000/callback",
    apiBase: API_BASES[e.KROGER_ENV ?? "prod"],
    dataDir: e.KROGER_MCP_DATA_DIR ?? join(configHome, "kroger-mcp"),
    defaultLocationId: e.KROGER_LOCATION_ID,
  };
}
