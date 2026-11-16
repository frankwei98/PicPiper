// Rebuild the checked-in portable ICC engine and synthetic test profiles.
// Normal application builds use the checked-in artifacts and need no WASI SDK.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { WASI } from "node:wasi";

const version = "2.20";
const expected = "18ff5504fa9cc8a2b1f3591180d90ead16c8a2ea78e530523b46eab70e1ca6b9";
const sdk = process.env.WASI_SDK_PATH;
if (!sdk) throw new Error("Set WASI_SDK_PATH to wasi-sdk 34. Application builds do not need this regeneration step.");
const cache = resolve(".tools/color");
mkdirSync(cache, { recursive: true });
const archive = join(cache, `lcms2-${version}.tar.gz`);
if (!existsSync(archive)) {
  const response = await fetch(`https://github.com/mm2/Little-CMS/releases/download/lcms${version}/lcms2-${version}.tar.gz`);
  if (!response.ok) throw new Error(`LittleCMS source download failed: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(data).digest("hex") !== expected) throw new Error("LittleCMS source checksum mismatch");
  writeFileSync(archive, data);
}
if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== expected) throw new Error("LittleCMS source checksum mismatch");
execFileSync("tar", ["-xzf", archive, "-C", cache]);
const source = join(cache, `lcms2-${version}`);
const target = resolve("internal/imaging/icc");
const files = readdirSync(join(source, "src")).filter((file) => file.endsWith(".c")).sort().map((file) => join(source, "src", file));
execFileSync(join(sdk, "bin", "clang"), ["-O2", "-mexec-model=reactor", `-I${join(source, "include")}`, join(target, "src/bridge.c"), ...files,
  ...["malloc", "free", "pp_transform", "pp_apply", "pp_close", "pp_profile"].map((name) => `-Wl,--export=${name}`),
  "-Wl,-z,stack-size=1048576", "-Wl,--initial-memory=2097152", "-Wl,--max-memory=67108864", "-lm", "-o", join(target, "lcms.wasm")], { stdio: "inherit" });
chmodSync(join(target, "lcms.wasm"), 0o644);
writeFileSync(join(target, "LICENSE"), readFileSync(join(source, "LICENSE"), "utf8").replace(/[ \t]+$/gm, ""));
const wasi = new WASI({ version: "preview1", args: [], env: {}, preopens: {} });
const { instance } = await WebAssembly.instantiate(readFileSync(join(target, "lcms.wasm")), wasi.getImportObject());
wasi.initialize(instance);
const api = instance.exports;
for (const [kind, name] of ["srgb.icc", "display-p3.icc", "rgb-lut.icc"].entries()) {
  const size = api.pp_profile(kind, 0, 0);
  if (!size) throw new Error(`Could not generate ${name}`);
  const pointer = api.malloc(size);
  if (!pointer || !api.pp_profile(kind, pointer, size)) throw new Error(`Could not serialize ${name}`);
  const data = Buffer.from(new Uint8Array(api.memory.buffer, pointer, size));
  [2026, 11, 16, 0, 0, 0].forEach((value, index) => data.writeUInt16BE(value, 24 + index * 2));
  writeFileSync(resolve("internal/imaging/testdata", name), data);
  api.free(pointer);
}
console.log(`Built LittleCMS ${version} and deterministic synthetic ICC profiles.`);
