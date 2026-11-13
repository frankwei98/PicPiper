import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

if (process.platform !== "darwin") {
  throw new Error("The packaged UI smoke driver currently supports macOS. Go and frontend tests run on other platforms.");
}
const config = JSON.parse(readFileSync(resolve("mygo.json"), "utf8"));
const app = resolve(config.out, `darwin-${process.arch}`, `${config.name}.app`);
if (!existsSync(join(app, "Contents", "MacOS", config.name))) throw new Error("Build the app with pnpm build before running pnpm smoke.");
mkdirSync(resolve("build"), { recursive: true });
const reportDir = mkdtempSync(join(resolve("build"), "smoke-"));
copyFileSync(resolve("internal/cloud/r2_connected.html"), join(reportDir, "oauth-connected.html"));
copyFileSync(resolve("internal/imaging/testdata/sample.heic"), join(reportDir, "Imported HEIC.heic"));
try {
  const output = execFileSync("/usr/bin/open", ["-W", "-n", app, "--args", "--smoke-test", reportDir], { encoding: "utf8", timeout: 240_000 });
  process.stdout.write(output);
} catch (error) {
  console.error(`Desktop smoke failed. Artifacts: ${reportDir}`);
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
}
const report = JSON.parse(readFileSync(join(reportDir, "report.json"), "utf8"));
console.log(`Desktop smoke artifacts: ${reportDir}`);
if (!report.passed) throw new Error(report.error || "Desktop smoke did not pass.");
