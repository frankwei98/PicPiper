import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lockIsStale } from "./native-codec.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeLock({ pid, age = 60_000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pic-piper-lock-"));
  roots.push(root);
  const lock = join(root, "lock");
  await mkdir(lock);
  if (pid !== undefined) await writeFile(join(lock, "pid"), pid);
  const time = new Date(Date.now() - age);
  await utimes(lock, time, time);
  return lock;
}

describe("lockIsStale", () => {
  it("reclaims an old lock that never recorded a pid", async () => {
    expect(await lockIsStale(await makeLock())).toBe(true);
  });

  it("keeps a fresh lock that is still being created", async () => {
    expect(await lockIsStale(await makeLock({ age: 0 }))).toBe(false);
  });

  it("reclaims empty and invalid pids after the creation window", async () => {
    expect(await lockIsStale(await makeLock({ pid: "" }))).toBe(true);
    expect(await lockIsStale(await makeLock({ pid: "not-a-pid" }))).toBe(true);
  });

  it("keeps a lock held by a live process", async () => {
    expect(await lockIsStale(await makeLock({ pid: String(process.pid), age: 0 }))).toBe(false);
  });

  it("reclaims a lock whose process has exited", async () => {
    const child = spawnSync(process.execPath, ["-e", ""]);
    expect(child.pid).toBeTypeOf("number");
    expect(await lockIsStale(await makeLock({ pid: String(child.pid), age: 0 }))).toBe(true);
  });
});
