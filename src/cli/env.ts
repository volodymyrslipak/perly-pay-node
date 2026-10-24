/**
 * The keys file (`.env.local` / `.env`) and the `.gitignore` that keeps it
 * out of git. Pure string work, so it is tested without a disk.
 */

export const KEY_VAR = "PERLY_PAY_SECRET_KEY";
export const WEBHOOK_SECRET_VAR = "PERLY_PAY_WEBHOOK_SECRET";
export const API_VAR = "PERLY_PAY_API";
export const DEFAULT_API = "https://pay.perly.io";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `--api` as an origin, or null. https, or plain http only to this machine
 * (as perly-pay-mcp's PERLY_PAY_API): init sends the key there, and a key
 * never crosses a network unencrypted. No user name, path, query or fragment,
 * so `https://pay.perly.io@evil.example` cannot pass for Perly Pay.
 */
export function checkApiOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/\/+$/, ""));
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  if (/[@?#\\]/.test(raw.trim().replace(/^https?:\/\//i, ""))) return null;
  const local = LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return url.origin;
}

const line = (name: string) => new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=(.*)$`, "m");

/** A variable's value in a dotenv file ("" when set empty), or null when absent. Quotes and a trailing comment are dropped. */
export function readEnvValue(content: string, name: string): string | null {
  const match = line(name).exec(content);
  if (!match) return null;
  let value = (match[1] ?? "").trim();
  const quoted = /^(['"])(.*)\1$/.exec(value);
  if (quoted) return quoted[2] ?? "";
  if (value.startsWith("#")) return "";
  value = value.replace(/\s+#.*$/, "");
  return value;
}

export interface EnvEntry {
  name: string;
  value: string;
  /** A comment line above it, when it is added. */
  comment?: string;
  /** Replace a value that is already there (an explicit flag said so). */
  replace?: boolean;
}

export type EnvOutcome = "added" | "replaced" | "kept" | "unchanged";

/**
 * Adds or fills each variable. A variable that already has a value is kept
 * unless `force` (or its own `replace`) says otherwise; an empty one is filled.
 */
export function upsertEnv(content: string, entries: readonly EnvEntry[], force = false): { content: string; outcomes: Record<string, EnvOutcome> } {
  let out = content;
  const outcomes: Record<string, EnvOutcome> = {};
  const added: string[] = [];
  for (const entry of entries) {
    const current = readEnvValue(out, entry.name);
    if (current === null) {
      if (entry.comment) added.push(`# ${entry.comment}`);
      added.push(`${entry.name}=${entry.value}`);
      outcomes[entry.name] = "added";
    } else if (current === entry.value) {
      outcomes[entry.name] = "unchanged";
    } else if (current === "" || force || entry.replace) {
      out = out.replace(line(entry.name), () => `${entry.name}=${entry.value}`);
      outcomes[entry.name] = "replaced";
    } else {
      outcomes[entry.name] = "kept";
    }
  }
  if (added.length) {
    const sep = out === "" ? "" : out.endsWith("\n") ? "\n" : "\n\n";
    out = `${out}${sep}# Perly Pay (npx perly-pay init). Keep this file out of git.\n${added.join("\n")}\n`;
  }
  return { content: out, outcomes };
}

function globToRegex(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end > i) {
        re += glob.slice(i, end + 1).replace(/^\[!/, "[^");
        i = end;
      } else re += "\\[";
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return re;
}

/**
 * Whether a root `.gitignore` ignores the file at `path` (relative, "/"-separated).
 * The common subset of git's rules: globs, `**`, a leading `/` anchors, a
 * trailing `/` matches folders, `!` re-includes, the last match wins.
 */
export function gitignoreIgnores(gitignore: string, path: string): boolean {
  const parts = path.split("/");
  let ignored = false;
  for (const raw of gitignore.split(/\r?\n/)) {
    let pattern = raw.replace(/(?<!\\)\s+$/, "");
    if (!pattern || pattern.startsWith("#")) continue;
    const negate = pattern.startsWith("!");
    if (negate) pattern = pattern.slice(1);
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    const anchored = pattern.includes("/");
    pattern = pattern.replace(/^\//, "");
    const re = new RegExp(`^${globToRegex(pattern)}$`);
    let hit = false;
    if (anchored) {
      // The pattern names a path from the root: the file itself, or a folder above it.
      for (let n = dirOnly ? parts.length - 1 : parts.length; n >= 1 && !hit; n--) hit = re.test(parts.slice(0, n).join("/"));
    } else {
      // A bare name matches at any depth: the file's name, or any folder above it.
      const names = dirOnly ? parts.slice(0, -1) : parts;
      hit = names.some((name) => re.test(name));
    }
    if (hit) ignored = !negate;
  }
  return ignored;
}

/** `.gitignore` with the keys file added when it is not ignored yet; null when it already is. */
export function ensureIgnored(gitignore: string | null, path: string): string | null {
  const current = gitignore ?? "";
  if (gitignoreIgnores(current, path)) return null;
  const sep = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  return `${current}${sep}# Perly Pay keys (npx perly-pay init)\n${path}\n`;
}

/** `sk_test_kest…`: enough to recognise a key, never the key. */
export function maskKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 12)}…` : `${key.slice(0, 8)}…`;
}

export type KeyCheck = { ok: true; key: string } | { ok: false; reason: "empty" | "live" | "malformed" };

/** init takes test keys only: a live key moves real money and belongs in the dashboard's go-live step. */
export function checkTestKey(raw: string | null | undefined): KeyCheck {
  const key = (raw ?? "").trim();
  if (!key) return { ok: false, reason: "empty" };
  if (key.startsWith("sk_live_")) return { ok: false, reason: "live" };
  if (!/^sk_test_[0-9A-Za-z]{32}$/.test(key)) return { ok: false, reason: "malformed" };
  return { ok: true, key };
}
