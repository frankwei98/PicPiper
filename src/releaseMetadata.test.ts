/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";

const releaseVersion = "0.1.1";

async function readVersions() {
  const [packageJson, cargoToml, tauriConfig] = await Promise.all([
    readFile(resolve(cwd(), "package.json"), "utf8"),
    readFile(resolve(cwd(), "src-tauri/Cargo.toml"), "utf8"),
    readFile(resolve(cwd(), "src-tauri/tauri.conf.json"), "utf8"),
  ]);

  return {
    npm: JSON.parse(packageJson).version as string,
    cargo: /^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1],
    tauri: JSON.parse(tauriConfig).version as string,
  };
}

describe("release metadata", () => {
  it("declares the published v0.1.1 version in every build manifest", async () => {
    await expect(readVersions()).resolves.toEqual({
      npm: releaseVersion,
      cargo: releaseVersion,
      tauri: releaseVersion,
    });
  });
});
