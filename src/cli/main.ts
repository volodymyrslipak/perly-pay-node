/**
 * The `perly-pay` command: `npx perly-pay init`. A separate entry from the
 * library (`import "perly-pay"` never loads this), Node built-ins only.
 * `bin.ts` runs it; the tests call `main` with their own IO.
 */
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { SDK_VERSION } from "../http.js";
import { FRAMEWORKS, type Framework } from "./detect.js";
import { DEFAULT_API } from "./env.js";
import { init, type InitIO } from "./init.js";
import { DEFAULT_OFFER, type Offer } from "./templates.js";

export const HELP = `perly-pay ${SDK_VERSION} — crypto payments straight to your wallet

Usage
  npx perly-pay init [options]

Sets up Perly Pay in this project, in test mode: a checkout route, a webhook
route that checks signatures, a Pay button, and the keys in .env.local / .env
(kept out of git). Never replaces a file without --force.

Options
  -y, --yes               no questions (for AI assistants and scripts)
  --framework <name>      ${FRAMEWORKS.join(" | ")} (default: detected)
  --key <sk_test_…>       your test key (default: $PERLY_PAY_SECRET_KEY, or asks)
  --webhook-url <url>     register this URL for invoice.fulfilled and save its secret
  --product <name>        what you sell (default "${DEFAULT_OFFER.product}")
  --amount <cents>        its price in cents (default ${DEFAULT_OFFER.amount} = $20.00)
  --currency <USD|EUR>    default ${DEFAULT_OFFER.currency}
  --install               also install the SDK (otherwise prints the command)
  --force                 replace files and values that are already there
  --plugin                print how to add the Claude Code plugin
  --mcp                   print the MCP server config (${"perly-pay-mcp"})
  --api <origin>          Perly Pay's address (default ${DEFAULT_API})
  --dir <path>            the project (default: here)
  --dry-run               say what would happen, write nothing
  --json                  print the result as JSON
  -h, --help              this
  -v, --version           the version

Docs: https://pay.perly.io/docs/quick-start-npx`;

export interface Cli {
  argv: string[];
  cwd: string;
  io: InitIO;
}

export async function main({ argv, cwd, io }: Cli): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        yes: { type: "boolean", short: "y" },
        framework: { type: "string" },
        key: { type: "string" },
        "webhook-url": { type: "string" },
        product: { type: "string" },
        amount: { type: "string" },
        currency: { type: "string" },
        install: { type: "boolean" },
        force: { type: "boolean" },
        plugin: { type: "boolean" },
        mcp: { type: "boolean" },
        api: { type: "string" },
        dir: { type: "string" },
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    io.print(`perly-pay: ${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.version) {
    io.print(SDK_VERSION);
    return 0;
  }
  const command = positionals[0];
  if (v.help || !command || command === "help") {
    io.print(HELP);
    return command || v.help ? 0 : 2;
  }
  if (command !== "init") {
    io.print(`perly-pay: no command "${command}". Try: npx perly-pay init`);
    return 2;
  }

  const framework = v.framework === "nextjs" ? "next" : v.framework;
  if (framework !== undefined && !(FRAMEWORKS as readonly string[]).includes(framework)) {
    io.print(`perly-pay: --framework is one of ${FRAMEWORKS.join(", ")}.`);
    return 2;
  }
  const offer: Offer = { ...DEFAULT_OFFER };
  if (v.product !== undefined) {
    const product = v.product.trim();
    if (!product || product.length > 300) {
      io.print("perly-pay: --product is 1 to 300 characters.");
      return 2;
    }
    offer.product = product;
  }
  if (v.amount !== undefined) {
    if (!/^[1-9]\d{0,9}$/.test(v.amount)) {
      io.print("perly-pay: --amount is a whole number of cents: 2000 is $20.00.");
      return 2;
    }
    offer.amount = Number(v.amount);
  }
  if (v.currency !== undefined) {
    const currency = v.currency.toUpperCase();
    if (currency !== "USD" && currency !== "EUR") {
      io.print("perly-pay: --currency is USD or EUR.");
      return 2;
    }
    offer.currency = currency;
  }

  const result = await init(
    {
      dir: resolve(cwd, v.dir ?? "."),
      framework: framework as Framework | undefined,
      key: v.key,
      api: v.api,
      yes: v.yes,
      force: v.force,
      install: v.install,
      plugin: v.plugin,
      mcp: v.mcp,
      webhookUrl: v["webhook-url"],
      offer,
      dryRun: v["dry-run"],
      json: v.json,
    },
    io,
  );
  return result.ok ? 0 : 1;
}

/** Opens a URL in the default browser; quietly does nothing where there is none. */
function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", '""', url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser: the URL is printed above.
  }
}

export function nodeIO(): InitIO {
  return {
    env: process.env,
    interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
    print: (text) => process.stdout.write(`${text}\n`),
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    openUrl,
    run(command, cwd) {
      return spawnSync(command, { cwd, shell: true, stdio: "inherit" }).status ?? 1;
    },
  };
}
