import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const macOSMinimum = "13.0";

function run(command, args, env = process.env) {
  try {
    return execFileSync(command, args, { env, encoding: "utf8", maxBuffer: 16 << 20 });
  } catch (error) {
    throw new Error(`${command} failed: ${error.stderr?.toString() || error.message}`);
  }
}

// Cgo parses quoted flags itself; these strings are never evaluated by a shell.
const flag = (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

// A builder writes its pid immediately after creating the lock directory.
// Missing or unusable pid files are therefore either mid-creation or stale.
const lockGraceMs = 5_000;

export async function lockIsStale(lock) {
  let pid;
  try {
    pid = Number((await readFile(join(lock, "pid"), "utf8")).trim());
  } catch (error) {
    if (error.code !== "ENOENT") return false;
  }
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  }
  // Give a builder that just created the directory time to record its pid
  // before treating the lock as abandoned. Older locks are reclaimed.
  try {
    const { mtimeMs } = await stat(lock);
    return Date.now() - mtimeMs > lockGraceMs;
  } catch (error) {
    return error.code === "ENOENT";
  }
}

export async function prepareNativeCodec({ name, archives, revision, libraries, build }) {
  const target = JSON.parse(run("go", ["env", "-json", "CGO_ENABLED", "GOOS", "GOARCH", "CC"]));
  const hostArch = process.arch === "x64" ? "amd64" : process.arch;
  if (target.CGO_ENABLED !== "1" || !["darwin", "linux"].includes(target.GOOS) || target.GOOS !== process.platform || target.GOARCH !== hostArch) return null;

  const key = createHash("sha256").update(JSON.stringify({ ...target, archives, revision, macOSMinimum })).digest("hex").slice(0, 12);
  const directory = join(root, ".tools", `native-${name}`, `${target.GOOS}-${target.GOARCH}-${key}`);
  const sources = Object.fromEntries(Object.keys(archives).map((id) => [id, join(directory, id)]));
  const install = join(directory, "install");
  const ready = join(directory, "ready");
  await mkdir(directory, { recursive: true });
  if (!existsSync(ready)) {
    const lock = join(directory, "lock");
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      try {
        await mkdir(lock);
        await writeFile(join(lock, "pid"), String(process.pid));
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (await lockIsStale(lock)) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > deadline) throw new Error(`Timed out waiting for native ${name} build: ${lock}`);
        await new Promise((done) => setTimeout(done, 200));
      }
    }
    try {
      if (!existsSync(ready)) {
        console.error(`Preparing static ${name} libraries (cached after the first build).`);
        for (const [id, { url, sha256 }] of Object.entries(archives)) {
          const archive = join(directory, `${id}.tar.gz`);
          if (!existsSync(archive)) {
            const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
            if (!response.ok) throw new Error(`${id} download failed: HTTP ${response.status}`);
            await writeFile(archive, Buffer.from(await response.arrayBuffer()));
          }
          if (createHash("sha256").update(await readFile(archive)).digest("hex") !== sha256) {
            await rm(archive, { force: true });
            throw new Error(`${id} source checksum mismatch`);
          }
          await mkdir(sources[id], { recursive: true });
          run("tar", ["-xzf", archive, "-C", sources[id], "--strip-components=1"]);
        }
        const env = { ...process.env, CC: target.CC };
        const cmake = (id, options, extraEnv = {}) => {
          const buildDir = join(directory, `cmake-${id}`);
          const cmakeEnv = { ...env, ...extraEnv };
          run("cmake", ["-S", sources[id], "-B", buildDir,
            "-DBUILD_SHARED_LIBS=OFF", "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_INSTALL_LIBDIR=lib",
            `-DCMAKE_INSTALL_PREFIX=${install}`,
            ...(target.GOOS === "darwin" ? [`-DCMAKE_OSX_DEPLOYMENT_TARGET=${macOSMinimum}`] : []),
            ...options], cmakeEnv);
          run("cmake", ["--build", buildDir, "--parallel", String(Math.min(4, availableParallelism()))], cmakeEnv);
          run("cmake", ["--install", buildDir], cmakeEnv);
        };
        build({ sources, install, target, cmake });
        await writeFile(ready, `${key}\n`);
      }
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  return {
    sources,
    cflags: flag(`-I${join(install, "include")}`),
    ldflags: libraries.map((lib) => flag(join(install, "lib", lib))).join(" "),
    env: {
      ...process.env,
      // MyGo otherwise resets an unset CGO_ENABLED to 0 for its nested builds.
      CGO_ENABLED: "1",
      ...(target.GOOS === "darwin" ? { MACOSX_DEPLOYMENT_TARGET: process.env.MACOSX_DEPLOYMENT_TARGET || macOSMinimum } : {}),
    },
  };
}
