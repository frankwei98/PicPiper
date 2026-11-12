import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const webpVersion = "1.6.0";
const sourceHash = "e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564";
const sourceURL = `https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-${webpVersion}.tar.gz`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Match Go 1.27's Darwin runtime floor instead of the build host's SDK version.
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

export async function prepareNativeWebP() {
  const target = JSON.parse(run("go", ["env", "-json", "CGO_ENABLED", "GOOS", "GOARCH", "CC"]));
  const hostArch = process.arch === "x64" ? "amd64" : process.arch;
  if (target.CGO_ENABLED !== "1" || !["darwin", "linux"].includes(target.GOOS) || target.GOOS !== process.platform || target.GOARCH !== hostArch) {
    return null;
  }
  const key = createHash("sha256").update(JSON.stringify({ ...target, sourceHash, macOSMinimum })).digest("hex").slice(0, 12);
  // Dot directories are excluded from `go test ./...` package discovery.
  const directory = join(root, ".tools", "native-webp", `${target.GOOS}-${target.GOARCH}-${key}`);
  const source = join(directory, "source");
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
        try {
          const pid = Number(await readFile(join(lock, "pid"), "utf8"));
          if (pid > 0) process.kill(pid, 0);
        } catch (ownerError) {
          if (ownerError.code === "ESRCH") {
            await rm(lock, { recursive: true, force: true });
            continue;
          }
        }
        if (Date.now() > deadline) throw new Error(`Timed out waiting for native WebP build: ${lock}`);
        await new Promise((done) => setTimeout(done, 200));
      }
    }
    try {
      if (!existsSync(ready)) {
        console.error(`Preparing static libwebp ${webpVersion} (cached after the first build).`);
        const archive = join(directory, `libwebp-${webpVersion}.tar.gz`);
        if (!existsSync(archive)) {
          const response = await fetch(sourceURL, { signal: AbortSignal.timeout(60_000) });
          if (!response.ok) throw new Error(`libwebp download failed: HTTP ${response.status}`);
          await writeFile(archive, Buffer.from(await response.arrayBuffer()));
        }
        const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
        if (digest !== sourceHash) {
          await rm(archive, { force: true });
          throw new Error("libwebp source checksum mismatch");
        }
        await mkdir(source, { recursive: true });
        run("tar", ["-xzf", archive, "-C", source, "--strip-components=1"]);
        const build = join(directory, "cmake");
        const options = [
          "-DBUILD_SHARED_LIBS=OFF", "-DWEBP_LINK_STATIC=ON", "-DCMAKE_BUILD_TYPE=Release",
          "-DCMAKE_INSTALL_LIBDIR=lib", `-DCMAKE_INSTALL_PREFIX=${install}`,
          ...["ANIM_UTILS", "CWEBP", "DWEBP", "GIF2WEBP", "IMG2WEBP", "VWEBP", "WEBPINFO", "LIBWEBPMUX", "WEBPMUX", "EXTRAS"].map((name) => `-DWEBP_BUILD_${name}=OFF`),
        ];
        if (target.GOOS === "darwin") options.push(`-DCMAKE_OSX_DEPLOYMENT_TARGET=${macOSMinimum}`);
        const env = { ...process.env, CC: target.CC };
        run("cmake", ["-S", source, "-B", build, ...options], env);
        run("cmake", ["--build", build, "--parallel", String(Math.min(4, availableParallelism()))], env);
        run("cmake", ["--install", build], env);
        await writeFile(ready, `${sourceHash}\n`);
      }
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  return {
    source,
    env: {
      ...process.env,
      // MyGo otherwise resets an unset CGO_ENABLED to 0 for its nested builds.
      CGO_ENABLED: "1",
      ...(target.GOOS === "darwin" ? { MACOSX_DEPLOYMENT_TARGET: process.env.MACOSX_DEPLOYMENT_TARGET || macOSMinimum } : {}),
      CGO_CFLAGS: `${process.env.CGO_CFLAGS ?? ""} ${flag(`-I${join(install, "include")}`)}`.trim(),
      CGO_LDFLAGS: `${process.env.CGO_LDFLAGS ?? ""} ${flag(join(install, "lib", "libwebp.a"))} ${flag(join(install, "lib", "libsharpyuv.a"))} -lm -pthread`.trim(),
    },
  };
}
