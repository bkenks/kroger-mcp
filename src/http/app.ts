import type { Server } from "node:http";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import type { HttpConfig } from "../config.js";
import { createServer } from "../server.js";
import { JsonStore } from "../store.js";
import type { Deps, LoginFlow } from "../tools/shared.js";
import { CONSENT_PATH, type CallbackOutcome, KrogerOAuthProvider, consentCookieName, escapeHtml } from "./oauth.js";
import { renderPage } from "./pages.js";

export const KROGER_LOGIN_PATH = "/kroger/login";
export const KROGER_CALLBACK_PATH = "/kroger/callback";

/** HTTP mode: kroger_login points the user at this server's own Kroger login route. */
export function remoteLoginFlow(http: HttpConfig): LoginFlow {
  return {
    async start() {
      return {
        loginUrl: new URL(KROGER_LOGIN_PATH, http.publicUrl).href,
        instructions:
          "Ask the user to open loginUrl and sign in with the Kroger account that owns this server. " +
          "Then call auth_status to confirm.",
      };
    },
  };
}

export function createHttpApp(deps: Deps, http: HttpConfig, provider?: KrogerOAuthProvider): Express {
  provider ??= new KrogerOAuthProvider(http, new JsonStore(deps.config.dataDir), deps.tokens, deps.client);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", http.trustProxy);

  // Before host validation so container/orchestrator health checks work with any Host header.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(hostHeaderValidation(http.allowedHosts));

  // OAuth discovery metadata plus /authorize, /token, /register, /revoke.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: http.publicUrl,
      resourceServerUrl: http.mcpUrl,
      resourceName: "Kroger MCP",
    }),
  );

  const browserLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });

  app.post(CONSENT_PATH, browserLimiter, express.urlencoded({ extended: false }), (req, res) => {
    const outcome = provider.handleConsent(req.body ?? {}, parseCookies(req.headers.cookie));
    if (typeof req.body?.request === "string") {
      res.clearCookie(consentCookieName(req.body.request), { path: CONSENT_PATH });
    }
    sendOutcome(res, outcome);
  });

  app.get(KROGER_LOGIN_PATH, browserLimiter, (_req, res) => {
    res.redirect(302, provider.beginReconnect());
  });

  app.get(KROGER_CALLBACK_PATH, browserLimiter, async (req, res) => {
    sendOutcome(res, await provider.handleKrogerCallback(req.query));
  });

  const requireAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(http.mcpUrl),
  });

  // Stateless Streamable HTTP: a fresh MCP server per request; shared deps keep token caches warm.
  app.post(http.mcpUrl.pathname, requireAuth, express.json({ limit: "1mb" }), async (req, res) => {
    const server = createServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: unknown, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (this server is stateless; use POST)." },
      id: null,
    });
  };
  app.get(http.mcpUrl.pathname, methodNotAllowed);
  app.delete(http.mcpUrl.pathname, methodNotAllowed);

  return app;
}

export function startHttpServer(deps: Deps, http: HttpConfig): Promise<Server> {
  const app = createHttpApp(deps, http);
  return new Promise((resolve, reject) => {
    const server = app.listen(http.port, http.host, (err?: Error) => (err ? reject(err) : resolve(server)));
  });
}

function sendOutcome(res: Response, outcome: CallbackOutcome) {
  if ("redirect" in outcome) {
    res.redirect(302, outcome.redirect);
    return;
  }
  const title = outcome.status < 300 ? "Kroger MCP" : "Kroger MCP: something went wrong";
  res.status(outcome.status).type("html").send(renderPage(title, `<p>${escapeHtml(outcome.message)}</p>`));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      try {
        cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        // ignore malformed cookie values
      }
    }
  }
  return cookies;
}
