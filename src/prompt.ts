import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

/** Interactive terminal prompts for `kroger-mcp setup`. */

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const answer = (await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  return answer === "" ? defaultYes : answer.startsWith("y");
}

/** Read a line without echoing it (for secrets). Requires a TTY. */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    stdout.write(question);
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}
