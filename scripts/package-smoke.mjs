import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const config = JSON.parse(readFileSync("mygo.json", "utf8"));
const arch = process.arch === "x64" ? "amd64" : process.arch;
const system = process.platform === "win32" ? "windows" : process.platform;
const target = `${system}-${arch}`;
const directory = resolve(config.out, target);
const executable = process.platform === "darwin"
  ? join(directory, `${config.name}.app`, "Contents", "MacOS", config.name)
  : join(directory, process.platform === "win32" ? `${config.name}.exe` : config.slug);
if (!existsSync(executable)) throw new Error(`Build the app before package smoke: ${executable}`);
mkdirSync(resolve("build"), { recursive: true });
const reportDir = mkdtempSync(resolve("build", `package-smoke-${target}-`));
const log = openSync(join(reportDir, "process.log"), "w", 0o600);
console.log(`Package smoke artifacts: ${reportDir}`);
const child = spawn(executable, ["--package-smoke", reportDir], { stdio: ["ignore", log, log], detached: process.platform !== "win32" });
try {
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => {
      if (process.platform === "win32") {
        try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
      reject(new Error("Packaged app smoke timed out after 180 seconds"));
    }, 180_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) done();
      else reject(new Error(`Packaged app exited with ${signal || code}`));
    });
  });
  const report = JSON.parse(readFileSync(join(reportDir, "report.json"), "utf8"));
  if (!report.passed) throw new Error(report.error || "Package smoke did not pass");
  if (report.version !== config.version || report.target !== target) throw new Error("Packaged version or architecture differs from the build configuration");
  console.log(`PASS: ${target} ${report.version}; ${report.steps.length} package checks`);
} catch (error) {
  console.error(readFileSync(join(reportDir, "process.log"), "utf8"));
  throw error;
} finally {
  closeSync(log);
}
