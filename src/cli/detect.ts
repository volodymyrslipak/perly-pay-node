/**
 * What kind of project `npx perly-pay init` is standing in: the framework,
 * the package manager, TypeScript or not, ES modules or CommonJS, and
 * where the code and the keys go. Reads files only — never runs anything.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const FRAMEWORKS = ["next", "express", "hono", "laravel", "node"] as const;
export type Framework = (typeof FRAMEWORKS)[number];
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "composer";
/** How generated JavaScript is written: TypeScript, JS as ES modules, or JS as CommonJS. */
export type CodeStyle = "ts" | "esm" | "cjs";

export const FRAMEWORK_NAMES: Record<Framework, string> = {
  next: "Next.js (App Router)",
  express: "Express",
  hono: "Hono",
  laravel: "Laravel",
  node: "Node.js",
};

export interface Project {
  dir: string;
  framework: Framework;
  packageManager: PackageManager;
  style: CodeStyle;
  /** "src/" when the project keeps its code there, else "". */
  base: string;
  /** Next.js: the App Router directory, `app` or `src/app`. */
  appDir: string;
  /** Where the keys go: `.env.local` for Next.js, `.env` elsewhere. */
  envFile: string;
  /** perly-pay (or perly/perly-pay for Laravel) is already a dependency. */
  hasSdk: boolean;
  /** dotenv (or an equivalent) already loads `.env`. */
  loadsEnv: boolean;
  /** Things worth saying about what was found. */
  notes: string[];
}

export class DetectError extends Error {}

type Json = Record<string, unknown>;

function readJson(path: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function depsOf(pkg: Json | null, ...fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const deps = pkg?.[field];
    if (deps && typeof deps === "object") Object.assign(out, deps);
  }
  return out;
}

/** The framework the files say, or null when nothing here looks like a project. */
export function detectFramework(dir: string): Framework | null {
  const composer = readJson(join(dir, "composer.json"));
  if (existsSync(join(dir, "artisan")) || "laravel/framework" in depsOf(composer, "require")) return "laravel";
  const pkg = readJson(join(dir, "package.json"));
  if (!pkg) return null;
  const deps = depsOf(pkg, "dependencies", "devDependencies");
  if ("next" in deps) return "next";
  if ("hono" in deps) return "hono";
  if ("express" in deps) return "express";
  return "node";
}

export function detectPackageManager(dir: string, framework: Framework): PackageManager {
  if (framework === "laravel") return "composer";
  const declared = readJson(join(dir, "package.json"))?.packageManager;
  if (typeof declared === "string") {
    const name = declared.split("@")[0];
    if (name === "pnpm" || name === "yarn" || name === "bun" || name === "npm") return name;
  }
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  return "npm";
}

/** The tsconfig's `module`, lower-case, when it says one (comments and trailing commas tolerated). */
function tsModule(dir: string): string | null {
  try {
    const text = readFileSync(join(dir, "tsconfig.json"), "utf8");
    const match = /"module"\s*:\s*"([^"]+)"/i.exec(text);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function detectProject(dir: string, forced?: Framework): Project {
  const found = detectFramework(dir);
  const framework = forced ?? found;
  if (!framework) {
    throw new DetectError("No package.json or composer.json here. Run this in your project's folder, or pass --framework.");
  }
  const notes: string[] = [];
  if (forced && found && forced !== found) notes.push(`This looks like ${FRAMEWORK_NAMES[found]}; using ${FRAMEWORK_NAMES[forced]} as asked.`);

  const packageManager = detectPackageManager(dir, framework);
  const pkg = readJson(join(dir, "package.json"));
  const deps = depsOf(pkg, "dependencies", "devDependencies");

  if (framework === "laravel") {
    const composer = readJson(join(dir, "composer.json"));
    return {
      dir,
      framework,
      packageManager,
      style: "esm",
      base: "",
      appDir: "",
      envFile: ".env",
      hasSdk: "perly/perly-pay" in depsOf(composer, "require"),
      loadsEnv: true,
      notes,
    };
  }

  const typescript = existsSync(join(dir, "tsconfig.json")) || "typescript" in deps;
  const style: CodeStyle = typescript ? "ts" : framework === "next" || pkg?.type === "module" ? "esm" : "cjs";
  const mod = typescript ? tsModule(dir) : null;
  if (typescript && framework !== "next" && mod === "commonjs") {
    notes.push('tsconfig compiles to CommonJS, and perly-pay is an ES module: set "module": "nodenext" (or run with tsx).');
  }

  let base = "";
  let appDir = "";
  if (framework === "next") {
    if (isDir(join(dir, "src", "app"))) appDir = "src/app";
    else if (isDir(join(dir, "app"))) appDir = "app";
    else if (isDir(join(dir, "src"))) appDir = "src/app";
    else appDir = "app";
    base = appDir.startsWith("src/") ? "src/" : "";
    if (!isDir(join(dir, appDir)) && (isDir(join(dir, "pages")) || isDir(join(dir, "src", "pages")))) {
      notes.push(`No App Router yet: the routes go in ${appDir}/, which Next.js serves beside pages/.`);
    }
  } else if (isDir(join(dir, "src"))) {
    base = "src/";
  }

  return {
    dir,
    framework,
    packageManager,
    style,
    base,
    appDir,
    envFile: framework === "next" ? ".env.local" : ".env",
    hasSdk: "perly-pay" in deps,
    // Next.js loads .env.local itself; elsewhere something must.
    loadsEnv: framework === "next" || "dotenv" in deps || "@dotenvx/dotenvx" in deps,
    notes,
  };
}

export function installCommand(project: Pick<Project, "packageManager">): string {
  switch (project.packageManager) {
    case "composer":
      return "composer require perly/perly-pay";
    case "pnpm":
      return "pnpm add perly-pay";
    case "yarn":
      return "yarn add perly-pay";
    case "bun":
      return "bun add perly-pay";
    default:
      return "npm install perly-pay";
  }
}
