import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const helper = join(dirname(fileURLToPath(import.meta.url)), "codec-lock", "main.go");

// Native codecs are built only on the macOS/Linux host with cgo enabled.
// Keep the lock file: unlinking it would let waiters lock different inodes.
export async function acquireNativeBuildLock(path, timeoutMs = 10 * 60_000) {
  const holder = spawn("go", ["run", helper, path], {
    env: { ...process.env, CGO_ENABLED: "0", GOFLAGS: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostics = "";
  holder.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-4096); });
  const closed = new Promise((resolve) => holder.once("close", (code) => resolve(code)));
  let timer;
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      holder.once("error", reject);
      holder.once("close", (code) => reject(new Error(`Build lock helper exited (${code}): ${diagnostics}`)));
      holder.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("locked\n")) resolve();
      });
      timer = setTimeout(() => reject(new Error(`Timed out waiting for native build lock: ${path}`)), timeoutMs);
    });
  } catch (error) {
    holder.stdin.destroy();
    holder.kill();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  let released;
  return () => released ??= (async () => {
    holder.stdin.end();
    const code = await closed;
    if (code !== 0) throw new Error(`Build lock helper exited (${code}): ${diagnostics}`);
  })();
}
