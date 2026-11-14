import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") {
  console.log("System app-icon checks require macOS.");
  process.exit(0);
}

const config = JSON.parse(readFileSync(resolve("mygo.json"), "utf8"));
const app = resolve(config.out, `darwin-${process.arch}`, `${config.name}.app`);
if (!existsSync(join(app, "Contents", "Resources", "AppIcon.icns"))) throw new Error("Build the app before checking its system icon.");
const reportDir = resolve(process.argv[2] ?? "build/app-icon-check");
mkdirSync(reportDir, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "pic-piper-icon-check-"));
const snapshot = join(reportDir, "system-app-icon.png");
let passed = false;
try {
  const executable = join(temporary, "system-icon-check");
  execFileSync("/usr/bin/clang", ["-Wall", "-Werror", "-framework", "Cocoa", resolve("scripts/icon/testdata/system-icon.m"), "-o", executable], { stdio: "inherit" });
  execFileSync(executable, [app, snapshot], { stdio: "inherit", timeout: 10_000 });
  passed = true;
} finally {
  writeFileSync(join(reportDir, "app-icon-report.json"), JSON.stringify({ passed, snapshot }, null, 2) + "\n");
  rmSync(temporary, { recursive: true, force: true });
  console.log(`System app-icon artifacts: ${reportDir}`);
}
