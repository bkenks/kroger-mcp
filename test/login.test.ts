import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { listenForAuthCode } from "../src/login.js";

const noop = async () => {};

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  await new Promise((r) => srv.close(r));
  return port;
}

describe("listenForAuthCode", () => {
  it("exchanges the code for a matching state and ignores mismatched ones", async () => {
    const port = await freePort();
    const redirect = `http://127.0.0.1:${port}/callback`;
    const exchanged: string[] = [];
    const listener = await listenForAuthCode(redirect, "good-state", 5000, async (code) => {
      exchanged.push(code);
    });

    const bad = await fetch(`${redirect}?code=evil&state=wrong`);
    expect(bad.status).toBe(400);

    const ok = await fetch(`${redirect}?code=abc123&state=good-state`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toMatch(/login complete/i);
    await expect(listener.done).resolves.toBeUndefined();
    expect(exchanged).toEqual(["abc123"]);
  });

  it("shows the browser a failed token exchange instead of claiming success", async () => {
    const port = await freePort();
    const redirect = `http://127.0.0.1:${port}/callback`;
    const listener = await listenForAuthCode(redirect, "s", 5000, async () => {
      throw new Error("redirect_uri mismatch");
    });

    const res = await fetch(`${redirect}?code=abc&state=s`);
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/redirect_uri mismatch/);
    await expect(listener.done).rejects.toThrow(/redirect_uri mismatch/);
  });

  it("rejects when Kroger redirects with an error", async () => {
    const port = await freePort();
    const redirect = `http://127.0.0.1:${port}/callback`;
    const listener = await listenForAuthCode(redirect, "s", 5000, noop);
    await fetch(`${redirect}?error=access_denied&error_description=User+declined&state=s`);
    await expect(listener.done).rejects.toThrow(/User declined/);
  });

  it("rejects non-loopback redirect URIs", async () => {
    await expect(listenForAuthCode("https://example.com/cb", "s", 1000, noop)).rejects.toThrow(/localhost/);
  });

  it("reports a busy port clearly", async () => {
    const port = await freePort();
    const redirect = `http://127.0.0.1:${port}/callback`;
    const first = await listenForAuthCode(redirect, "s", 5000, noop);
    await expect(listenForAuthCode(redirect, "s", 5000, noop)).rejects.toThrow(/already in use/);
    first.close();
  });
});
