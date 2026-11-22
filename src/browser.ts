import { spawn } from "node:child_process";

/** Best-effort: open a URL in the default browser. Callers always print the URL too. */
export function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // no browser available; the URL is printed anyway
    child.unref();
  } catch {
    // ignore
  }
}
