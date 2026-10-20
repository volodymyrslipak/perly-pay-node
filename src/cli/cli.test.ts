import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject, installCommand, type Project } from "./detect";
import { checkTestKey, ensureIgnored, gitignoreIgnores, maskKey, readEnvValue, upsertEnv } from "./env";
import { init, type InitIO, type InitOptions } from "./init";
import { HELP, main } from "./main";
import { planFiles, type GeneratedFile } from "./templates";

/**
 * `npx perly-pay init`, without a terminal, a browser or a network: real
 * project folders in a temp dir, a fake IO, and the generated TypeScript
 * type-checked against the SDK's own source.
 */

const TEST_KEY = "sk_test_kestrelLOCALdevONLYkey0000000000";
// Built from parts so secret scanners do not take this made-up key for a real one.
const LIVE_KEY = ["sk", "live", "kestrelLOCALdevONLYkey0000000000"].join("_");
const sdkSrc = fileURLToPath(new URL("../index.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project folder from a map of files (objects are written as JSON). */
function fixture(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), "perly-init-"));
  made.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

const FIXTURES = {
  nextTsSrcPnpm: {
    "package.json": { dependencies: { next: "16.0.0", react: "19.0.0" } },
    "tsconfig.json": "{}",
    "pnpm-lock.yaml": "",
    "src/app/page.tsx": "",
    ".gitignore": "node_modules\n.env*.local\n",
  },
  nextJs: { "package.json": { dependencies: { next: "15.0.0" } }, "app/page.jsx": "", "package-lock.json": "{}" },
  expressEsmYarn: { "package.json": { type: "module", dependencies: { express: "5.1.0" } }, "yarn.lock": "" },
  expressCjs: { "package.json": { dependencies: { express: "4.21.0", dotenv: "16.0.0" } } },
  expressTs: { "package.json": { dependencies: { express: "5.1.0" }, devDependencies: { typescript: "5.9.0" } }, "tsconfig.json": '{ "compilerOptions": { "module": "nodenext" } }', "src/index.ts": "" },
  honoBun: { "package.json": { packageManager: "bun@1.2.0", dependencies: { hono: "4.0.0" } }, "tsconfig.json": "{}" },
  laravel: { "composer.json": { require: { php: "^8.2", "laravel/framework": "^11.0" } }, artisan: "", ".gitignore": "/vendor\n.env\n" },
  node: { "package.json": { type: "module", dependencies: {} } },
} satisfies Record<string, Record<string, string | object>>;

function fakeIO(over: Partial<InitIO> & { answers?: string[] } = {}): InitIO & { out: string[]; opened: string[]; ran: string[] } {
  const out: string[] = [];
  const opened: string[] = [];
  const ran: string[] = [];
  const answers = [...(over.answers ?? [])];
  return {
    env: {},
    interactive: false,
    print: (text) => out.push(text),
    ask: async () => answers.shift() ?? "",
    openUrl: (url) => opened.push(url),
    run: (command) => (ran.push(command), 0),
    ...over,
    out,
    opened,
    ran,
  };
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

describe("detecting the project", () => {
  it("knows Next.js with src/app, TypeScript and pnpm", () => {
    const p = detectProject(fixture(FIXTURES.nextTsSrcPnpm));
    expect(p).toMatchObject({ framework: "next", packageManager: "pnpm", style: "ts", appDir: "src/app", base: "src/", envFile: ".env.local", loadsEnv: true, hasSdk: false });
  });

  it("knows Next.js in JavaScript with app/ at the root", () => {
    expect(detectProject(fixture(FIXTURES.nextJs))).toMatchObject({ framework: "next", packageManager: "npm", style: "esm", appDir: "app", base: "" });
  });

  it("knows Express as ES modules, as CommonJS, and in TypeScript", () => {
    expect(detectProject(fixture(FIXTURES.expressEsmYarn))).toMatchObject({ framework: "express", packageManager: "yarn", style: "esm", envFile: ".env", loadsEnv: false });
    expect(detectProject(fixture(FIXTURES.expressCjs))).toMatchObject({ framework: "express", style: "cjs", loadsEnv: true });
    expect(detectProject(fixture(FIXTURES.expressTs))).toMatchObject({ framework: "express", style: "ts", base: "src/", notes: [] });
  });

  it("warns when TypeScript compiles to CommonJS (perly-pay is an ES module)", () => {
    const p = detectProject(fixture({ ...FIXTURES.expressTs, "tsconfig.json": '{ "compilerOptions": { "module": "CommonJS" } }' }));
    expect(p.notes.join(" ")).toMatch(/nodenext/);
  });

  it("knows Hono and bun from packageManager", () => {
    expect(detectProject(fixture(FIXTURES.honoBun))).toMatchObject({ framework: "hono", packageManager: "bun", style: "ts" });
  });

  it("knows Laravel by composer.json or artisan", () => {
    expect(detectProject(fixture(FIXTURES.laravel))).toMatchObject({ framework: "laravel", packageManager: "composer", envFile: ".env" });
    expect(detectProject(fixture({ artisan: "" })).framework).toBe("laravel");
  });

  it("falls back to plain Node, and refuses an empty folder", () => {
    expect(detectProject(fixture(FIXTURES.node)).framework).toBe("node");
    expect(() => detectProject(fixture({}))).toThrow(/package\.json/);
  });

  it("takes --framework over what it finds, and says so", () => {
    const p = detectProject(fixture(FIXTURES.expressEsmYarn), "hono");
    expect(p.framework).toBe("hono");
    expect(p.notes[0]).toMatch(/looks like Express/);
  });

  it("knows when the SDK is already there, and how to install it", () => {
    expect(detectProject(fixture({ "package.json": { dependencies: { express: "5", "perly-pay": "0.1.0" } } })).hasSdk).toBe(true);
    expect(installCommand({ packageManager: "pnpm" })).toBe("pnpm add perly-pay");
    expect(installCommand({ packageManager: "composer" })).toBe("composer require perly/perly-pay");
  });
});

describe("the keys file", () => {
  it("reads values, quoted or not, with or without export", () => {
    const env = 'A=1\nexport PERLY_PAY_SECRET_KEY="sk_test_x"\nPERLY_PAY_WEBHOOK_SECRET= # later\n';
    expect(readEnvValue(env, "PERLY_PAY_SECRET_KEY")).toBe("sk_test_x");
    expect(readEnvValue(env, "PERLY_PAY_WEBHOOK_SECRET")).toBe("");
    expect(readEnvValue(env, "NOPE")).toBeNull();
  });

  it("adds what is missing under one comment, fills what is empty, keeps what is set", () => {
    const { content, outcomes } = upsertEnv("A=1\nPERLY_PAY_WEBHOOK_SECRET=\nPERLY_PAY_API=http://x", [
      { name: "PERLY_PAY_SECRET_KEY", value: TEST_KEY, comment: "key" },
      { name: "PERLY_PAY_WEBHOOK_SECRET", value: "whsec_1" },
      { name: "PERLY_PAY_API", value: "http://y" },
    ]);
    expect(outcomes).toEqual({ PERLY_PAY_SECRET_KEY: "added", PERLY_PAY_WEBHOOK_SECRET: "replaced", PERLY_PAY_API: "kept" });
    expect(content).toBe(`A=1\nPERLY_PAY_WEBHOOK_SECRET=whsec_1\nPERLY_PAY_API=http://x\n\n# Perly Pay (npx perly-pay init). Keep this file out of git.\n# key\nPERLY_PAY_SECRET_KEY=${TEST_KEY}\n`);
  });

  it("replaces a set value only with force or an explicit replace, and never reads $ as a pattern", () => {
    expect(upsertEnv("K=old\n", [{ name: "K", value: "n$&w" }], true).content).toBe("K=n$&w\n");
    expect(upsertEnv("K=old\n", [{ name: "K", value: "new", replace: true }]).outcomes.K).toBe("replaced");
    expect(upsertEnv("K=same\n", [{ name: "K", value: "same" }]).outcomes.K).toBe("unchanged");
  });

  it("knows which .gitignore lines cover a keys file", () => {
    for (const rule of [".env*", ".env*.local", "*.local", "/.env.local", ".env.*", "**/.env.local"]) {
      expect(gitignoreIgnores(`node_modules\n${rule}\n`, ".env.local"), rule).toBe(true);
    }
    expect(gitignoreIgnores(".env\n", ".env.local")).toBe(false);
    expect(gitignoreIgnores(".env*\n!.env.local\n", ".env.local")).toBe(false);
    expect(gitignoreIgnores("# .env\nenv/\n", ".env")).toBe(false);
    expect(gitignoreIgnores("config/\n", "config/.env")).toBe(true);
  });

  it("adds the keys file to .gitignore only when it is not covered", () => {
    expect(ensureIgnored("node_modules", ".env")).toBe("node_modules\n\n# Perly Pay keys (npx perly-pay init)\n.env\n");
    expect(ensureIgnored(null, ".env")).toBe("# Perly Pay keys (npx perly-pay init)\n.env\n");
    expect(ensureIgnored(".env*\n", ".env.local")).toBeNull();
  });

  it("takes test keys, refuses live ones, and never shows a whole key", () => {
    expect(checkTestKey(` ${TEST_KEY} `)).toEqual({ ok: true, key: TEST_KEY });
    expect(checkTestKey(LIVE_KEY)).toEqual({ ok: false, reason: "live" });
    expect(checkTestKey("sk_test_short")).toEqual({ ok: false, reason: "malformed" });
    expect(checkTestKey("")).toEqual({ ok: false, reason: "empty" });
    expect(maskKey(TEST_KEY)).toBe("sk_test_kest…");
  });
});

describe("init", () => {
  const run = (dir: string, options: Partial<InitOptions> = {}, io = fakeIO()) => init({ dir, yes: true, ...options }, io).then((result) => ({ result, io }));

  it("writes Next.js routes, a button, the keys and the .gitignore line", async () => {
    const dir = fixture(FIXTURES.nextTsSrcPnpm);
    const { result } = await run(dir, { key: TEST_KEY });
    expect(result.ok).toBe(true);
    expect(result.files.map((f) => [f.path, f.status])).toEqual([
      ["src/lib/perly-pay.ts", "written"],
      ["src/app/api/perly-pay/checkout/route.ts", "written"],
      ["src/app/api/perly-pay/webhook/route.ts", "written"],
      ["src/components/PayButton.tsx", "written"],
      ["src/app/perly-pay/page.tsx", "written"],
    ]);
    expect(read(dir, ".env.local")).toContain(`PERLY_PAY_SECRET_KEY=${TEST_KEY}\n`);
    expect(read(dir, ".env.local")).toContain("PERLY_PAY_WEBHOOK_SECRET=\n");
    expect(result.gitignore).toBe("already ignored");
    expect(result.next.join("\n")).toMatch(/pnpm add perly-pay/);
    expect(result.next.join("\n")).toMatch(/Simulate payment/);
  });

  it("never replaces a file or a key without --force", async () => {
    const dir = fixture({ ...FIXTURES.expressEsmYarn, "lib/perly-pay.js": "// mine\n", ".env": "PERLY_PAY_SECRET_KEY=sk_test_otherKEYotherKEYotherKEYother000\n" });
    const first = await run(dir);
    expect(first.result.files[0]).toEqual({ path: "lib/perly-pay.js", status: "kept" });
    expect(read(dir, "lib/perly-pay.js")).toBe("// mine\n");
    expect(first.result.env.PERLY_PAY_SECRET_KEY).toBe("unchanged");
    expect(first.io.out.join("\n")).toMatch(/--force replaces it/);

    const forced = await run(dir, { force: true });
    expect(forced.result.files[0]?.status).toBe("replaced");
    expect(read(dir, "lib/perly-pay.js")).toContain("handleWebhook");

    const again = await run(dir);
    expect(again.result.files.every((f) => f.status === "unchanged")).toBe(true);
  });

  it("refuses a live key from any source, and writes nothing", async () => {
    for (const [options, env] of [
      [{ key: LIVE_KEY }, {}],
      [{}, { PERLY_PAY_SECRET_KEY: LIVE_KEY }],
    ] as const) {
      const dir = fixture(FIXTURES.expressEsmYarn);
      const { result, io } = await run(dir, options, fakeIO({ env }));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/live key/);
      expect(io.out.join("\n")).toMatch(/test mode only/);
      expect(existsSync(join(dir, "lib"))).toBe(false);
      expect(existsSync(join(dir, ".env"))).toBe(false);
    }
  });

  it("leaves a placeholder and says where to get a key when nobody can answer", async () => {
    const dir = fixture(FIXTURES.expressEsmYarn);
    const io = fakeIO();
    const { result } = await run(dir, { yes: false }, io);
    expect(result.key).toBe("placeholder");
    expect(io.opened).toEqual([]);
    expect(read(dir, ".env")).toContain("PERLY_PAY_SECRET_KEY=\n");
    expect(read(dir, ".gitignore")).toContain(".env\n");
    expect(result.next.join("\n")).toContain("https://pay.perly.io/dashboard/developers");
  });

  it("opens the Developers page, refuses a pasted live key, and takes the test key after it", async () => {
    const dir = fixture(FIXTURES.expressEsmYarn);
    const io = fakeIO({ interactive: true, answers: [LIVE_KEY, TEST_KEY] });
    const { result } = await run(dir, { yes: false, api: "http://localhost:3273" }, io);
    expect(io.opened).toEqual(["http://localhost:3273/dashboard/developers"]);
    expect(io.out.join("\n")).toMatch(/That is a live key/);
    expect(result.key).toBe("set");
    expect(read(dir, ".env")).toContain(`PERLY_PAY_SECRET_KEY=${TEST_KEY}`);
    expect(read(dir, ".env")).toContain("PERLY_PAY_API=http://localhost:3273");
    expect(io.out.join("\n")).not.toContain(TEST_KEY);
  });

  it("does not copy a key from the shell's environment into a file", async () => {
    const dir = fixture(FIXTURES.expressEsmYarn);
    const { result } = await run(dir, {}, fakeIO({ env: { PERLY_PAY_SECRET_KEY: TEST_KEY } }));
    expect(result.key).toBe("set");
    expect(read(dir, ".env")).not.toContain(TEST_KEY);
  });

  it("registers --webhook-url and saves its secret; a second run keeps it", async () => {
    const dir = fixture(FIXTURES.expressEsmYarn);
    const calls: string[] = [];
    const endpoints: object[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { url: string; enabled_events: string[] };
        expect(body.enabled_events).toEqual(["invoice.fulfilled"]);
        const ep = { id: "we_1", object: "webhook_endpoint", url: body.url, secret: "whsec_fresh" };
        endpoints.push({ ...ep, secret: undefined });
        return json(ep, 201);
      }
      return json({ object: "list", data: endpoints, has_more: false, next_cursor: null });
    }) as typeof fetch;
    const io = fakeIO({ fetch: fakeFetch });
    const { result } = await run(dir, { key: TEST_KEY, api: "http://localhost:3273", webhookUrl: "http://localhost:4567/perly-pay/webhook" }, io);
    expect(result.webhook).toEqual({ url: "http://localhost:4567/perly-pay/webhook", endpoint: "we_1", secret: "created" });
    expect(read(dir, ".env")).toContain("PERLY_PAY_WEBHOOK_SECRET=whsec_fresh");
    expect(calls).toEqual(["GET /api/v1/webhook_endpoints", "POST /api/v1/webhook_endpoints"]);

    const again = await run(dir, { api: "http://localhost:3273", webhookUrl: "http://localhost:4567/perly-pay/webhook" }, io);
    expect(again.result.webhook?.secret).toBe("kept");
    expect(read(dir, ".env")).toContain("PERLY_PAY_WEBHOOK_SECRET=whsec_fresh");
  });

  it("--webhook-url needs a key", async () => {
    const { result } = await run(fixture(FIXTURES.expressEsmYarn), { webhookUrl: "https://x.example/perly-pay/webhook" });
    expect(result.error).toMatch(/needs a test key/);
  });

  it("--install runs the install; --dry-run writes nothing", async () => {
    const dir = fixture(FIXTURES.honoBun);
    const io = fakeIO();
    const { result } = await run(dir, { install: true }, io);
    expect(io.ran).toEqual(["bun add perly-pay"]);
    expect(result.install).toEqual({ command: "bun add perly-pay", ran: true, status: 0 });

    const dry = fixture(FIXTURES.node);
    const d = await run(dry, { dryRun: true, install: true }, fakeIO());
    expect(d.result.files.every((f) => f.status === "would write")).toBe(true);
    expect(existsSync(join(dry, ".env"))).toBe(false);
    expect(existsSync(join(dry, ".gitignore"))).toBe(false);
  });

  it("prints the plugin and the MCP config when asked, and JSON for machines", async () => {
    const io = fakeIO();
    await run(fixture(FIXTURES.node), { plugin: true, mcp: true, json: true }, io);
    const parsed = JSON.parse(io.out[0]!) as { ok: boolean; next: string[]; framework: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.framework).toBe("node");
    const next = parsed.next.join("\n");
    expect(next).toContain("/plugin install perly-pay");
    expect(next).toContain("npx -y perly-pay-mcp");
    expect(next).not.toContain(TEST_KEY);
  });

  it("writes Laravel's controller, routes, config and view, for composer", async () => {
    const dir = fixture(FIXTURES.laravel);
    const { result } = await run(dir, { key: TEST_KEY, offer: { product: "O'Brien's audit", amount: 15000, currency: "EUR" } });
    expect(result.files.map((f) => f.path)).toEqual([
      "config/perly-pay.php",
      "app/Http/Controllers/PerlyPayController.php",
      "routes/perly-pay.php",
      "resources/views/perly-pay/button.blade.php",
    ]);
    const controller = read(dir, "app/Http/Controllers/PerlyPayController.php");
    expect(controller).toContain(`'description' => 'O\\'Brien\\'s audit', 'amount' => 15000, 'currency' => 'EUR'`);
    expect(controller).toContain("Webhook::verify($request->getContent()");
    expect(controller).toContain("TODO: grant access");
    expect(read(dir, "routes/perly-pay.php")).toContain("withoutMiddleware");
    expect(read(dir, "resources/views/perly-pay/button.blade.php")).toContain("@csrf");
    expect(result.next.join("\n")).toContain("composer require perly/perly-pay");
    expect(result.next.join("\n")).toContain("require __DIR__.'/perly-pay.php';");
    expect(read(dir, ".env")).toContain(`PERLY_PAY_SECRET_KEY=${TEST_KEY}`);
  });
});

describe("the command line", () => {
  const cli = async (argv: string[], dir = fixture(FIXTURES.node)) => {
    const io = fakeIO();
    const code = await main({ argv, cwd: dir, io });
    return { code, out: io.out.join("\n"), dir };
  };

  it("helps, versions, and refuses what it does not know", async () => {
    expect((await cli(["--help"])).out).toBe(HELP);
    expect((await cli([])).code).toBe(2);
    expect((await cli(["-v"])).out).toMatch(/^\d+\.\d+\.\d+$/);
    expect((await cli(["deploy"])).code).toBe(2);
    expect((await cli(["init", "--nope"])).code).toBe(2);
    expect((await cli(["init", "--framework", "rails"])).out).toMatch(/one of next/);
    expect((await cli(["init", "--amount", "19.99"])).out).toMatch(/whole number of cents/);
    expect((await cli(["init", "--currency", "GBP"])).code).toBe(2);
  });

  it("runs init with --yes and the offer flags", async () => {
    const r = await cli(["init", "--yes", "--key", TEST_KEY, "--product", "Code review", "--amount", "4900", "--framework", "nextjs"]);
    expect(r.code).toBe(0);
    expect(read(r.dir, "lib/perly-pay.js")).toContain('one_off: { description: "Code review", amount: 4900, currency: "USD", credits: 0 }, // $49.00');
    expect((await cli(["init", "--yes", "--key", LIVE_KEY])).code).toBe(1);
  });
});

// ── the generated code compiles ───────────────────────────────────

const typesDir = join(repoRoot, "node_modules", "@types");

/** Type-checks generated TypeScript against the SDK's source, strictly (as strict as a project might be). */
function typecheck(files: GeneratedFile[], extra: ts.CompilerOptions = {}): string[] {
  const dir = mkdtempSync(join(tmpdir(), "perly-init-ts-"));
  made.push(dir);
  const roots: string[] = [];
  for (const f of files) {
    const target = join(dir, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
    roots.push(target);
  }
  const program = ts.createProgram(roots, {
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    typeRoots: [typesDir],
    types: ["node"],
    paths: {
      "perly-pay": [sdkSrc],
      react: [join(typesDir, "react", "index.d.ts")],
      "react/jsx-runtime": [join(typesDir, "react", "jsx-runtime.d.ts")],
    },
    ...extra,
  });
  // Only the generated files: the SDK's own source is checked by its own build, not under these flags.
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => !d.file || d.file.fileName.startsWith(dir))
    .map((d) => `${d.file?.fileName.replace(dir, "") ?? ""}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

/** JavaScript has no types to check, but it must parse. */
function syntaxErrors(file: GeneratedFile): string[] {
  const out = ts.transpileModule(file.content, {
    fileName: file.path,
    reportDiagnostics: true,
    compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 },
  });
  return (out.diagnostics ?? []).map((d) => `${file.path}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

const project = (dir: string): Project => detectProject(dir);

describe("the generated code", () => {
  it("type-checks for Next.js (App Router, TypeScript)", () => {
    const plan = planFiles(project(fixture(FIXTURES.nextTsSrcPnpm)));
    expect(typecheck(plan.files)).toEqual([]);
  }, 60_000);

  it("type-checks for plain Node (node:http, TypeScript, nodenext)", () => {
    const plan = planFiles(project(fixture({ ...FIXTURES.node, "tsconfig.json": "{}" })));
    expect(typecheck(plan.files, { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext })).toEqual([]);
  }, 60_000);

  it("catches a type error (the check is real)", () => {
    const plan = planFiles(project(fixture(FIXTURES.nextTsSrcPnpm)));
    const broken = plan.files.map((f) => (f.path.endsWith("lib/perly-pay.ts") ? { ...f, content: f.content.replace("amount,\n", "amount: String(amount),\n") } : f));
    expect(typecheck(broken).join("\n")).toMatch(/lib\/perly-pay\.ts: Type 'string' is not assignable to type 'number'/);
  }, 60_000);

  it("parses as JavaScript for every framework and module style", () => {
    const dirs = [FIXTURES.nextJs, FIXTURES.expressEsmYarn, FIXTURES.expressCjs, { ...FIXTURES.honoBun, "tsconfig.json": undefined }, FIXTURES.node, { "package.json": {} }];
    for (const files of dirs) {
      const clean = Object.fromEntries(Object.entries(files).filter(([, v]) => v !== undefined)) as Record<string, string | object>;
      const plan = planFiles(project(fixture(clean)));
      for (const f of plan.files) expect(syntaxErrors(f)).toEqual([]);
    }
  });

  it("CommonJS loads the ES-module SDK with import(), not require()", () => {
    const plan = planFiles(project(fixture(FIXTURES.expressCjs)));
    const core = plan.files[0]!.content;
    expect(core).toContain('import("perly-pay")');
    expect(core).not.toContain('require("perly-pay")');
    expect(core).toContain("module.exports = {");
  });

  it("checks the signature on the raw body in every framework", () => {
    for (const files of [FIXTURES.nextTsSrcPnpm, FIXTURES.expressEsmYarn, FIXTURES.honoBun, FIXTURES.node]) {
      const all = planFiles(project(fixture(files)))
        .files.map((f) => f.content)
        .join("\n");
      expect(all).toMatch(/request\.text\(\)|express\.raw|c\.req\.text\(\)|readBody\(req\)/);
      expect(all).toContain('event.type === "invoice.fulfilled"');
      expect(all).toContain("TODO: grant access");
    }
  });
});

describe("the package", () => {
  const pkgRoot = new URL("../../", import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL("package.json", pkgRoot), "utf8")) as { bin?: Record<string, string>; files: string[]; scripts: Record<string, string> };

  it("ships `npx perly-pay` as a bin inside dist, built by its own tsconfig", () => {
    expect(pkg.bin).toEqual({ "perly-pay": "./dist/cli/bin.js" });
    expect(pkg.files).toContain("dist");
    expect(pkg.scripts.build).toContain("tsc -p tsconfig.cli.json");
    expect(readFileSync(new URL("src/cli/bin.ts", pkgRoot), "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
  });

  it("keeps the library free of the CLI: `import \"perly-pay\"` loads no Node built-in", () => {
    for (const file of ["index.ts", "http.ts", "webhooks.ts", "errors.ts", "sha256.ts", "types.ts"]) {
      const source = readFileSync(new URL(`src/${file}`, pkgRoot), "utf8");
      expect(source, file).not.toMatch(/from "(?:node:|\.\/cli)/);
    }
  });
});
