/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function read(path: string) {
  return readFile(resolve(process.cwd(), path), "utf8");
}

describe("desktop release configuration", () => {
  it("uses the same version for the frontend and MyGo app", async () => {
    const [packageText, appText] = await Promise.all([read("package.json"), read("mygo.json")]);
    const pkg = JSON.parse(packageText);
    const app = JSON.parse(appText);
    expect(app.version).toBe(pkg.version);
    expect(app.frontendDist).toBe("dist");
    expect(app.out).not.toBe(app.frontendDist);
    expect(app.identifier).toBe("xyz.frankwei.pic-piper.mygo");
    expect(app.macos.minimumSystemVersion).toBe("13.0");
  });

  it("pins the bridge runtime and Go framework to the same version", async () => {
    const [packageText, moduleText] = await Promise.all([read("package.json"), read("go.mod")]);
    const pkg = JSON.parse(packageText);
    const version = /github\.com\/egoist\/mygo v([^\s]+)/.exec(moduleText)?.[1];
    expect(version).toBeDefined();
    expect(pkg.dependencies["mygo-runtime"]).toBe(version);
    expect(pkg.scripts.build).toContain(`mygo@v${version} build`);
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((name) => name.startsWith("@tauri-apps/"))).toBe(false);
  });

  it("checks both languages before packaging the MVP", async () => {
    const workflow = await read(".github/workflows/release.yml");
    expect(workflow).toMatch(/needs: quality/);
    expect(workflow).toContain("pnpm test");
    expect(workflow).toContain("pnpm build:web");
    expect(workflow).toContain("node scripts/go.mjs test -race ./internal/...");
    expect(workflow).toContain("CGO_ENABLED=0 node scripts/go.mjs test ./internal/...");
    expect(workflow).toContain("pnpm smoke");
    expect(workflow).not.toMatch(/cargo|rust-toolchain|tauri-action/);
  });
});
