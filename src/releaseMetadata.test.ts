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

function jobDefinition(workflow: string, jobName: string) {
  const jobStart = workflow.indexOf(`  ${jobName}:\n`);
  if (jobStart === -1) {
    return "";
  }

  const remainingJobs = workflow.slice(jobStart + 1);
  const nextJob = remainingJobs.search(/^  [a-z][a-z0-9_-]*:\n/m);
  return nextJob === -1
    ? workflow.slice(jobStart)
    : remainingJobs.slice(0, nextJob);
}

describe("release metadata", () => {
  it("declares the published v0.1.1 version in every build manifest", async () => {
    await expect(readVersions()).resolves.toEqual({
      npm: releaseVersion,
      cargo: releaseVersion,
      tauri: releaseVersion,
    });
  });

  it("gates every release matrix build on a dedicated quality job", async () => {
    const workflow = await readFile(
      resolve(cwd(), ".github/workflows/release.yml"),
      "utf8",
    );
    const qualityJob = jobDefinition(workflow, "quality");
    const publishJob = jobDefinition(workflow, "publish");
    const qualityChecks = [
      "pnpm test",
      "pnpm build",
      "cd src-tauri && cargo test",
      "cd src-tauri && cargo fmt --check",
      "cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings",
    ];

    expect(qualityJob).toContain("runs-on: ubuntu-24.04");
    for (const command of qualityChecks) {
      expect(qualityJob).toContain(command);
    }

    expect(qualityJob).not.toContain("tauri-apps/tauri-action");
    expect(publishJob).toMatch(/^    needs: quality$/m);
    expect(publishJob).toContain("strategy:");
    expect(publishJob).toContain("Build and upload Tauri bundles");
  });
});
