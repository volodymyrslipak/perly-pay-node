import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "./http";

/**
 * What npm will publish. The owner publishes by hand (docs/PUBLISHING.md);
 * these hold the package to what that page promises, so a version bump in
 * one place and not the other, or a test file in the tarball, fails here
 * first.
 */
const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as Record<string, unknown>;

describe("the npm package", () => {
  it("is publishable under its name, MIT, with a licence file", () => {
    expect(pkg.name).toBe("perly-pay");
    expect(pkg.private).toBeUndefined();
    expect(pkg.license).toBe("MIT");
    expect(readFileSync(new URL("LICENSE", root), "utf8")).toMatch(/^MIT License/);
    expect(pkg.repository).toBeTruthy();
    expect(pkg.homepage).toMatch(/^https:\/\/pay\.perly\.io\//);
  });

  it("says the same version it sends in Perly-Client", () => {
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it("ships only the build, the README and the licence", () => {
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);
    expect((pkg.scripts as Record<string, string>).prepack).toBe("npm run build");
  });

  it("has no dependencies at all", () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
  });

  it("builds without the tests or source maps", () => {
    const tsconfig = JSON.parse(readFileSync(new URL("tsconfig.json", root), "utf8")) as {
      compilerOptions: Record<string, unknown>;
      exclude: string[];
    };
    expect(tsconfig.exclude).toContain("src/**/*.test.ts");
    expect(tsconfig.compilerOptions.sourceMap).toBe(false);
    expect(existsSync(new URL("README.md", root))).toBe(true);
  });
});
