import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { acquireNativeBuildLock } from "./native-codec-lock.mjs";

describe.skipIf(!["darwin", "linux"].includes(process.platform))("native codec build lock", () => {
  it("ignores application Go flags without changing the caller's flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "pic-piper-lock-flags-"));
    const originalFlags = process.env.GOFLAGS;
    let release;
    try {
      process.env.GOFLAGS = "-race";
      release = await acquireNativeBuildLock(join(root, "build.lock"));
      expect(process.env.GOFLAGS).toBe("-race");
    } finally {
      if (originalFlags === undefined) delete process.env.GOFLAGS;
      else process.env.GOFLAGS = originalFlags;
      if (release) await release();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("prepares an uncached codec once across concurrent build clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "pic-piper-codec-build-"));
    const name = `lock-test-${randomUUID()}`;
    const counter = join(root, "builds");
    const scripts = dirname(fileURLToPath(import.meta.url));
    const moduleURL = pathToFileURL(join(scripts, "native-codec.mjs")).href;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { appendFileSync } from 'node:fs';
        import { prepareNativeCodec } from ${JSON.stringify(moduleURL)};
        await prepareNativeCodec({name:${JSON.stringify(name)},archives:{},revision:'lock-regression',libraries:[],build(){
          appendFileSync(${JSON.stringify(counter)}, 'build\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
        }});
      `], { env: { ...process.env, CGO_ENABLED: "1", GOOS: process.platform, GOARCH: process.arch === "x64" ? "amd64" : process.arch }, stdio: ["ignore", "pipe", "pipe"] });
      let diagnostics = "";
      child.stderr.on("data", (chunk) => { diagnostics += chunk; });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(diagnostics)));
    });
    try {
      const results = await Promise.allSettled([run(), run()]);
      for (const result of results) expect(result.status, result.reason?.message).toBe("fulfilled");
      expect(await readFile(counter, "utf8")).toBe("build\n");
    } finally {
      await rm(join(scripts, "..", ".tools", `native-${name}`), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("serializes two waiters without removing a replacement holder", async () => {
    const root = await mkdtemp(join(tmpdir(), "pic-piper-lock-"));
    await mkdir(join(root, "lock")); // Legacy pid-less locks cannot delete the new holder.
    const path = join(root, "build.lock");
    const release = await acquireNativeBuildLock(path);
    const acquired = [];
    const waiters = [0, 1].map(async () => {
      const unlock = await acquireNativeBuildLock(path, 45_000);
      acquired.push(unlock);
      return unlock;
    });
    try {
      await delay(100);
      expect(acquired).toHaveLength(0);
      await release();
      const first = await Promise.race(waiters);
      await delay(100);
      expect(acquired).toHaveLength(1);
      await first();
      await Promise.all(waiters);
      expect(acquired).toHaveLength(2);
    } finally {
      await release();
      await Promise.allSettled(waiters.map(async (waiter) => (await waiter)()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("releases the lock when a client exits without cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "pic-piper-lock-exit-"));
    const path = join(root, "build.lock");
    const moduleURL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "native-codec-lock.mjs")).href;
    const client = spawn(process.execPath, ["--input-type=module", "-e", `
      import { acquireNativeBuildLock } from ${JSON.stringify(moduleURL)};
      await acquireNativeBuildLock(process.argv[1]);
      console.log('held');
      setInterval(() => {}, 1000);
    `, path], { stdio: ["ignore", "pipe", "pipe"] });
    let waiter;
    try {
      const [ready] = await once(client.stdout, "data");
      expect(ready.toString().trim()).toBe("held");
      let acquired = false;
      waiter = acquireNativeBuildLock(path, 45_000).then((release) => { acquired = true; return release; });
      await delay(100);
      expect(acquired).toBe(false);
      client.kill("SIGKILL");
      await (await waiter)();
    } finally {
      client.kill("SIGKILL");
      if (waiter) await (await waiter)();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("does not unlink or release another holder when a waiter times out", async () => {
    const root = await mkdtemp(join(tmpdir(), "pic-piper-lock-timeout-"));
    const path = join(root, "build.lock");
    const release = await acquireNativeBuildLock(path);
    try {
      const before = await stat(path);
      await expect(acquireNativeBuildLock(path, 100)).rejects.toThrow("Timed out");
      const after = await stat(path);
      expect(after.ino).toBe(before.ino);
    } finally {
      await release();
      await (await acquireNativeBuildLock(path))();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("lets a timed-out client exit while the owner still holds the lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "pic-piper-lock-cancel-"));
    const path = join(root, "build.lock");
    const release = await acquireNativeBuildLock(path);
    const moduleURL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "native-codec-lock.mjs")).href;
    const client = spawn(process.execPath, ["--input-type=module", "-e", `
      import { acquireNativeBuildLock } from ${JSON.stringify(moduleURL)};
      try {
        await acquireNativeBuildLock(process.argv[1], 1000);
        throw new Error('lock was acquired while the owner held it');
      } catch (error) {
        if (!error.message.startsWith('Timed out')) throw error;
        console.log('timed out');
      }
    `, path], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(client, "exit");
    try {
      const result = await Promise.race([exited, delay(5000, "still running", { ref: false })]);
      expect(result).not.toBe("still running");
      expect(result[0]).toBe(0);
      // The timed-out client's cleanup must not release the original owner.
      await expect(acquireNativeBuildLock(path, 100)).rejects.toThrow("Timed out");
    } finally {
      client.kill("SIGKILL");
      await release();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
