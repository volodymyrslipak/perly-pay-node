/**
 * `npx perly-pay init`: from an empty project to a working test-mode
 * checkout. Detects the framework, takes a TEST key, writes the code and
 * the keys file (kept out of git), and says what is left to do.
 *
 * Everything outside the disk goes through `InitIO`, so the tests drive
 * it without a terminal, a browser or a network.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PerlyPay } from "../index.js";
import { PerlyPayError } from "../errors.js";
import { DetectError, FRAMEWORK_NAMES, detectProject, installCommand, type Framework, type Project } from "./detect.js";
import {
  API_VAR,
  DEFAULT_API,
  KEY_VAR,
  WEBHOOK_SECRET_VAR,
  checkTestKey,
  ensureIgnored,
  maskKey,
  readEnvValue,
  upsertEnv,
  type EnvEntry,
  type EnvOutcome,
} from "./env.js";
import { DEFAULT_OFFER, planFiles, type Offer } from "./templates.js";

/** The Claude Code plugin and the MCP server, as their packages are named. */
export const PLUGIN_NAME = "perly-pay";
export const MCP_PACKAGE = "perly-pay-mcp";

export interface InitOptions {
  dir: string;
  framework?: Framework | undefined;
  key?: string | undefined;
  /** Perly Pay's origin. Default https://pay.perly.io. */
  api?: string | undefined;
  /** No questions: an assistant or a script is running this. */
  yes?: boolean;
  force?: boolean;
  install?: boolean;
  plugin?: boolean;
  mcp?: boolean;
  /** Registers this URL as a webhook endpoint (invoice.fulfilled) and writes its secret. */
  webhookUrl?: string | undefined;
  offer?: Offer;
  dryRun?: boolean;
  json?: boolean;
}

export interface InitIO {
  env: Record<string, string | undefined>;
  /** A person at a terminal can answer. */
  interactive: boolean;
  print(text: string): void;
  ask(question: string): Promise<string>;
  openUrl(url: string): void;
  /** Runs a shell command in `cwd`; the exit status. Only for --install. */
  run(command: string, cwd: string): number;
  fetch?: typeof fetch;
}

export type FileStatus = "written" | "replaced" | "kept" | "unchanged" | "would write";

export interface InitResult {
  ok: boolean;
  error?: string;
  framework?: Framework;
  packageManager?: string;
  language?: "typescript" | "javascript" | "php";
  files: { path: string; status: FileStatus }[];
  envFile?: string;
  env: Record<string, EnvOutcome>;
  key: "set" | "placeholder";
  gitignore?: "added" | "already ignored";
  install?: { command: string; ran: boolean; status?: number };
  webhook?: { url: string; endpoint: string; secret: "created" | "rolled" | "kept" } | null;
  routes?: { button: string; checkout: string; webhook: string };
  notes: string[];
  next: string[];
}

type KeySource = "--key" | "environment" | "keys file" | "pasted";

class InitError extends Error {}

const KEY_HELP = "init sets up test mode only. Make a test key (sk_test_…) in Dashboard → Developers; going live is a step in the dashboard, later.";

function explainKey(reason: "empty" | "live" | "malformed", where: string): string {
  if (reason === "live") return `That is a live key (sk_live_…) ${where}. ${KEY_HELP}`;
  return `That is not a test key ${where}: it looks like sk_test_ and 32 letters or digits.`;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function resolveKey(options: InitOptions, io: InitIO, envFileText: string, developersUrl: string): Promise<{ key: string | null; source: KeySource | null }> {
  const candidates: [string | null | undefined, KeySource, string][] = [
    [options.key, "--key", "in --key"],
    [io.env[KEY_VAR], "environment", `in $${KEY_VAR}`],
    [readEnvValue(envFileText, KEY_VAR), "keys file", "in the keys file"],
  ];
  for (const [raw, source, where] of candidates) {
    if (!raw?.trim()) continue;
    const check = checkTestKey(raw);
    if (!check.ok) throw new InitError(explainKey(check.reason, where));
    return { key: check.key, source };
  }
  if (!io.interactive || options.yes) return { key: null, source: null };

  io.print(`Opening ${developersUrl} — make a test key (sk_test_…) and paste it here.`);
  io.openUrl(developersUrl);
  for (let tries = 0; tries < 3; tries++) {
    const answer = (await io.ask("Test secret key (Enter to skip): ")).trim();
    if (!answer) return { key: null, source: null };
    const check = checkTestKey(answer);
    if (check.ok) return { key: check.key, source: "pasted" };
    io.print(explainKey(check.reason, "there"));
  }
  return { key: null, source: null };
}

async function registerWebhook(
  url: string,
  key: string,
  api: string,
  io: InitIO,
  haveSecret: boolean,
): Promise<{ endpoint: string; secret: string | null; how: "created" | "rolled" | "kept" }> {
  const pay = new PerlyPay(key, { baseUrl: api, ...(io.fetch ? { fetch: io.fetch } : {}) });
  for await (const endpoint of pay.webhookEndpoints.listAll({ limit: 100 })) {
    if (endpoint.url !== url) continue;
    if (haveSecret) return { endpoint: endpoint.id, secret: null, how: "kept" };
    // The secret is shown only when made or rolled; a fresh one is the only way to know it.
    const rolled = await pay.webhookEndpoints.rollSecret(endpoint.id);
    return { endpoint: endpoint.id, secret: rolled.secret ?? null, how: "rolled" };
  }
  const made = await pay.webhookEndpoints.create({ url, enabled_events: ["invoice.fulfilled"], description: "npx perly-pay init" });
  return { endpoint: made.id, secret: made.secret ?? null, how: "created" };
}

function language(project: Project): "typescript" | "javascript" | "php" {
  return project.framework === "laravel" ? "php" : project.style === "ts" ? "typescript" : "javascript";
}

export async function init(options: InitOptions, io: InitIO): Promise<InitResult> {
  const result: InitResult = { ok: false, files: [], env: {}, key: "placeholder", notes: [], next: [] };
  try {
    await run(options, io, result);
    result.ok = true;
  } catch (error) {
    if (error instanceof InitError || error instanceof DetectError) result.error = error.message;
    else if (error instanceof PerlyPayError) result.error = `Perly Pay said: ${error.message}`;
    else throw error;
  }
  if (options.json) io.print(JSON.stringify(result, null, 2));
  else io.print(summary(result, options));
  return result;
}

async function run(options: InitOptions, io: InitIO, result: InitResult): Promise<void> {
  const api = (options.api ?? DEFAULT_API).replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(api)) throw new InitError(`--api takes an origin, like ${DEFAULT_API} or http://localhost:3200.`);
  const developersUrl = `${api}/dashboard/developers`;
  const offer = options.offer ?? DEFAULT_OFFER;
  const project = detectProject(options.dir, options.framework);
  const plan = planFiles(project, offer);
  result.framework = project.framework;
  result.packageManager = project.packageManager;
  result.language = language(project);
  result.envFile = project.envFile;
  result.routes = { button: plan.buttonPath, checkout: plan.checkoutPath, webhook: plan.webhookPath };
  result.notes.push(...project.notes);

  const envPath = join(project.dir, project.envFile);
  const envText = readText(envPath) ?? "";
  const { key, source } = await resolveKey(options, io, envText, developersUrl);
  result.key = key ? "set" : "placeholder";

  // The network first: if Perly Pay refuses the endpoint, nothing has been written yet.
  let webhookSecret: string | null = null;
  result.webhook = null;
  if (options.webhookUrl) {
    if (!key) throw new InitError(`--webhook-url needs a test key: pass --key or set ${KEY_VAR}.`);
    const haveSecret = !!readEnvValue(envText, WEBHOOK_SECRET_VAR);
    if (options.dryRun) {
      result.notes.push(`Would register ${options.webhookUrl} for invoice.fulfilled.`);
    } else {
      const made = await registerWebhook(options.webhookUrl, key, api, io, haveSecret);
      webhookSecret = made.secret;
      result.webhook = { url: options.webhookUrl, endpoint: made.endpoint, secret: made.how };
    }
  }

  for (const file of plan.files) {
    const target = join(project.dir, file.path);
    const current = readText(target);
    let status: FileStatus;
    if (current === file.content) status = "unchanged";
    else if (current !== null && !options.force) status = "kept";
    else status = options.dryRun ? "would write" : current === null ? "written" : "replaced";
    if (status === "written" || status === "replaced") {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    result.files.push({ path: file.path, status });
  }

  const entries: EnvEntry[] = [
    { name: KEY_VAR, value: key ?? "", comment: `Test key from Dashboard → Developers (sk_test_…). Never commit it.`, replace: source === "--key" || source === "pasted" },
    { name: WEBHOOK_SECRET_VAR, value: webhookSecret ?? "", comment: "Your webhook endpoint's signing secret (whsec_…).", replace: webhookSecret !== null },
  ];
  if (api !== DEFAULT_API) entries.push({ name: API_VAR, value: api, comment: "Perly Pay's address, when it is not https://pay.perly.io.", replace: true });
  // Never write a key from the shell's environment into a file: it is already where the app reads it.
  if (source === "environment") entries.shift();
  const env = upsertEnv(envText, entries, options.force);
  result.env = env.outcomes;
  if (!options.dryRun && env.content !== envText) writeFileSync(envPath, env.content);

  const gitignorePath = join(project.dir, ".gitignore");
  const ignored = ensureIgnored(readText(gitignorePath), project.envFile);
  result.gitignore = ignored === null ? "already ignored" : "added";
  if (ignored !== null && !options.dryRun) writeFileSync(gitignorePath, ignored);

  const next = result.next;
  if (!project.hasSdk) {
    const command = installCommand(project);
    if (options.install && !options.dryRun) {
      const status = io.run(command, project.dir);
      result.install = { command, ran: true, status };
      if (status !== 0) next.push(`Install the SDK (that failed): ${command}`);
    } else {
      result.install = { command, ran: false };
      next.push(`Install the SDK: ${command}`);
    }
  }
  if (plan.mount) next.push(`Wire in the routes:\n${indent(plan.mount)}`);
  if (!project.loadsEnv) next.push(`Load ${project.envFile} when the app starts: node --env-file=${project.envFile} … (Node 20.6+), or dotenv.`);
  const finalSecret = webhookSecret ?? readEnvValue(env.content, WEBHOOK_SECRET_VAR);
  const finalKey = source === "environment" ? key : readEnvValue(env.content, KEY_VAR);
  if (!finalKey) next.push(`Add your test key: make one at ${developersUrl}, then set ${KEY_VAR}=sk_test_… in ${project.envFile}.`);
  if (!finalSecret) {
    const port = project.framework === "laravel" ? 8000 : 3000;
    next.push(
      [
        `Add a webhook: Dashboard → Developers → Webhooks → https://<your-domain>${plan.webhookPath}, event invoice.fulfilled;`,
        `paste its whsec_… into ${project.envFile} as ${WEBHOOK_SECRET_VAR}. Or let init do both:`,
        `  npx perly-pay init --webhook-url https://<public-url>${plan.webhookPath}`,
        `On your laptop, a tunnel gives a public URL: cloudflared tunnel --url http://localhost:${port}`,
      ].join("\n"),
    );
  }
  const core = plan.files[0]?.path ?? "";
  next.push(
    `Try it: start the app, open ${plan.buttonPath}, press Pay with crypto, then Simulate payment on the checkout. ` +
      `Your webhook gets invoice.fulfilled and grantAccess() runs — the TODO in ${project.framework === "laravel" ? plan.files[1]?.path : core}.`,
  );
  next.push("Go live in the dashboard: connect your wallet's public key, make a live key (sk_live_…) and a live webhook, and set them where the app runs.");
  if (options.plugin) next.push(`Claude Code plugin "${PLUGIN_NAME}" — in Claude Code:\n  /plugin install ${PLUGIN_NAME}`);
  if (options.mcp) {
    const envs: Record<string, string> = { [KEY_VAR]: "sk_test_…" };
    if (api !== DEFAULT_API) envs[API_VAR] = api;
    const flags = Object.entries(envs)
      .map(([k, v]) => `-e ${k}=${v}`)
      .join(" ");
    next.push(
      `MCP server (${MCP_PACKAGE}):\n  claude mcp add perly-pay ${flags} -- npx -y ${MCP_PACKAGE}\n  or in your client's MCP config:\n  ` +
        JSON.stringify({ mcpServers: { "perly-pay": { command: "npx", args: ["-y", MCP_PACKAGE], env: envs } } }),
    );
  }
  if (key && source) result.notes.push(`Test key ${maskKey(key)} (from ${source}).`);
}

function indent(text: string, by = "  "): string {
  return text
    .split("\n")
    .map((l) => by + l)
    .join("\n");
}

const MARK: Record<FileStatus, string> = { written: "+", replaced: "~", kept: "=", unchanged: "=", "would write": "?" };

function summary(r: InitResult, options: InitOptions): string {
  if (!r.ok) return `perly-pay init: ${r.error}`;
  const out: string[] = [];
  const lang = r.language === "typescript" ? "TypeScript" : r.language === "php" ? "PHP" : "JavaScript";
  out.push(`Perly Pay for ${FRAMEWORK_NAMES[r.framework!]} — ${lang}, ${r.packageManager}${options.dryRun ? " (dry run: nothing written)" : ""}`);
  out.push("");
  for (const f of r.files) {
    const why = f.status === "kept" ? "  (exists; --force replaces it)" : f.status === "unchanged" ? "  (already up to date)" : "";
    out.push(`  ${MARK[f.status]} ${f.path}${why}`);
  }
  for (const [name, outcome] of Object.entries(r.env)) {
    const what = outcome === "kept" ? "kept the value there" : outcome === "unchanged" ? "already set" : outcome;
    out.push(`  ${outcome === "added" ? "+" : outcome === "replaced" ? "~" : "="} ${r.envFile}: ${name} ${what}`);
  }
  out.push(`  ${r.gitignore === "added" ? "+" : "="} .gitignore: ${r.envFile} ${r.gitignore === "added" ? "added" : "already ignored"}`);
  if (r.webhook) out.push(`  + webhook ${r.webhook.url} (${r.webhook.endpoint}, secret ${r.webhook.secret})`);
  if (r.install?.ran) out.push(`  ${r.install.status === 0 ? "+" : "!"} ${r.install.command}${r.install.status === 0 ? "" : ` (exit ${r.install.status})`}`);
  for (const note of r.notes) out.push(`  · ${note}`);
  out.push("");
  out.push("Next");
  r.next.forEach((step, i) => out.push(`${String(i + 1).padStart(3)}. ${step.split("\n").join("\n     ")}`));
  return out.join("\n");
}

