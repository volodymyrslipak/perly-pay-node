import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "./detect";
import { planFiles } from "./templates";

/**
 * The plain node:http output, run for real: the generated handler behind
 * the mount it prints, in its own process, with a stand-in for the core
 * module. A failure on one request answers that request; the process
 * keeps serving (sdk/node-template-unhandled-rejection). A body too big
 * for a webhook or a form is refused before it is kept (sdk/node-template-body-unbounded).
 */

const PROJECT: Project = { dir: "", framework: "node", packageManager: "npm", style: "esm", base: "", appDir: "", envFile: ".env", hasSdk: false, loadsEnv: false, notes: [] };

let dir = "";
let child: ChildProcess;
let port = 0;
let exited: number | null | undefined;
const seen: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "perly-node-handler-"));
  const plan = planFiles(PROJECT);
  const handler = plan.files.find((f) => f.path === "perly-pay.js")!;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dir, "perly-pay.js"), handler.content);
  // The core module stands in: the API refuses a long user, as the real one does.
  const lib = join(dir, "lib");
  mkdirSync(lib);
  writeFileSync(
    join(lib, "perly-pay.js"),
    `export async function createCheckout(plan, options) {
  if ((options.user ?? "").length > 500) throw new Error("user: at most 500 characters");
  return { url: "https://pay.example/i/inv_1" };
}
export async function handleWebhook(raw) {
  return { status: 204, body: "" };
}
`,
  );
  writeFileSync(
    join(dir, "server.js"),
    `import { createServer } from "node:http";
import { perlyPayHandler } from "./perly-pay.js";
// The mount, as init prints it.
const server = createServer(async (req, res) => {
  if (await perlyPayHandler(req, res)) return;
  res.writeHead(404).end("yours");
});
server.listen(0, "127.0.0.1", () => console.log("port " + server.address().port));
`,
  );
  child = spawn(process.execPath, [join(dir, "server.js")], { stdio: ["ignore", "pipe", "pipe"] });
  child.on("exit", (code) => (exited = code));
  child.stderr!.on("data", (d: Buffer) => seen.push(d.toString()));
  port = await new Promise<number>((resolve, reject) => {
    child.stdout!.on("data", (d: Buffer) => {
      const m = /port (\d+)/.exec(d.toString());
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", () => reject(new Error(`server exited: ${seen.join("")}`)));
  });
}, 20_000);

afterAll(() => {
  child?.kill();
  rmSync(dir, { recursive: true, force: true });
});

function send(method: string, path: string, body?: string | Buffer, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Raw bytes, then hang up: the server sees the request start and never end. */
function abortAfter(text: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(text, () => setTimeout(() => (socket.destroy(), resolve()), 100));
    });
    socket.on("error", () => resolve());
  });
}

const stillServing = async () => {
  await new Promise((r) => setTimeout(r, 200));
  expect(exited, seen.join("")).toBeUndefined();
  expect(await send("GET", "/perly-pay")).toBe(200);
};

describe("the generated node:http handler", () => {
  it("leaves a path URL cannot parse (GET //) to the merchant's own routing", async () => {
    expect(await send("GET", "//")).toBe(404);
    await stillServing();
  });

  it("survives a POST whose sender hangs up halfway", async () => {
    await abortAfter("POST /perly-pay/webhook HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n{\"id\":");
    await stillServing();
  });

  it("answers 500 when the API refuses the checkout, and keeps serving", async () => {
    expect(await send("POST", "/perly-pay/checkout", `plan=one_off&user=${"u".repeat(501)}`, { "content-type": "application/x-www-form-urlencoded" })).toBe(500);
    await stillServing();
  });

  it("refuses a declared body over 1 MiB with 413, before reading it", async () => {
    // Only the head and a few bytes are sent: the answer must come from Content-Length alone.
    const status = await new Promise<number | string>((resolve) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/perly-pay/webhook", headers: { "content-length": String(2 * 1024 * 1024) } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        req.destroy();
      });
      req.on("error", () => resolve("cut off"));
      req.write("{}");
    });
    expect(status).toBe(413);
    await stillServing();
  });

  it("cuts off a chunked body once it passes 1 MiB", async () => {
    const outcome = await new Promise<string>((resolve) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/perly-pay/webhook" }, (res) => {
        res.resume();
        resolve(String(res.statusCode));
      });
      req.on("error", () => resolve("cut off"));
      const chunk = Buffer.alloc(256 * 1024, 0x61);
      let sent = 0;
      const pump = () => {
        while (sent < 12) {
          sent++;
          if (!req.write(chunk)) return void req.once("drain", pump);
        }
        req.end();
      };
      pump();
    });
    expect(["413", "cut off"]).toContain(outcome);
    await stillServing();
  });

  it("still takes a small checkout and a webhook", async () => {
    expect(await send("POST", "/perly-pay/checkout", "plan=one_off", { "content-type": "application/x-www-form-urlencoded" })).toBe(303);
    expect(await send("POST", "/perly-pay/webhook", "{}", { "perly-signature": "t=1,v1=00" })).toBe(204);
  });
});
