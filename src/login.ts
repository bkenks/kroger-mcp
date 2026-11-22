import { createServer, type Server } from "node:http";

export interface CallbackListener {
  /** Settles once the browser hits the redirect URI and `exchange` has run (or on error/timeout). */
  done: Promise<void>;
  close(): void;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Start a one-shot HTTP server on the redirect URI's port to receive the OAuth
 * authorization code and hand it to `exchange`. The browser is shown the real
 * outcome of the exchange. Resolves once the server is listening so port
 * conflicts surface immediately.
 */
export async function listenForAuthCode(
  redirectUri: string,
  expectedState: string,
  timeoutMs: number,
  exchange: (code: string) => Promise<void>,
): Promise<CallbackListener> {
  const url = new URL(redirectUri);
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `KROGER_REDIRECT_URI must be an http://localhost URL for the built-in login flow (got ${redirectUri}).`,
    );
  }
  const port = Number(url.port || 80);
  const host = url.hostname.replace(/^\[|\]$/g, "");

  let resolveDone!: () => void;
  let rejectDone!: (err: Error) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  // Callers may never await `done` (e.g. if the user abandons login); avoid unhandled rejections.
  done.catch(() => {});

  let exchanging = false;
  const server: Server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", redirectUri);
    if (reqUrl.pathname !== url.pathname) {
      res.writeHead(404).end();
      return;
    }
    const params = reqUrl.searchParams;
    if (params.get("state") !== expectedState) {
      // Stale tab or forged request: ignore it and keep waiting for the real one.
      respond(res, 400, "Login link expired or invalid. Start the login again.");
      return;
    }
    if (exchanging) {
      respond(res, 409, "Login is already being completed in another request.");
      return;
    }
    const error = params.get("error");
    if (error) {
      const err = new Error(`Kroger login failed: ${params.get("error_description") ?? error}`);
      respond(res, 400, err.message);
      finish(() => rejectDone(err));
      return;
    }
    const authCode = params.get("code");
    if (!authCode) {
      respond(res, 400, "Missing authorization code.");
      return;
    }
    exchanging = true;
    exchange(authCode).then(
      () => {
        respond(res, 200, "Kroger login complete. You can close this window and return to your assistant.");
        finish(() => resolveDone());
      },
      (err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        respond(res, 502, e.message);
        finish(() => rejectDone(e));
      },
    );
  });

  const timer = setTimeout(
    () => finish(() => rejectDone(new Error("Timed out waiting for Kroger login."))),
    timeoutMs,
  );
  timer.unref();

  let finished = false;
  function finish(settle: () => void) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    // Let the in-flight response flush (it sends Connection: close); drop idle keep-alives.
    server.close();
    server.closeIdleConnections();
    settle();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`Port ${port} is already in use; cannot receive the Kroger login callback.`)
          : err,
      );
    });
    server.listen(port, host, () => resolve());
  });

  return {
    done,
    close: () => finish(() => rejectDone(new Error("Login cancelled."))),
  };
}

function respond(res: import("node:http").ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Kroger MCP</title>` +
      `<body style="font-family:sans-serif;margin:3em"><p>${escapeHtml(message)}</p></body>`,
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
