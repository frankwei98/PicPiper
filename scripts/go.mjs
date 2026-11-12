import { spawn } from "node:child_process";
import { prepareNativeWebP } from "./native-webp.mjs";

// Use bundled codecs on every machine, independent of installed shared libraries.
const tags = new Set(["nodynamic"]);
const native = ["build", "test", "run", "vet", "generate"].includes(process.argv[2]) ? await prepareNativeWebP() : null;
if (native) tags.add("nativewebp");
const flags = (process.env.GOFLAGS ?? "").replace(/(?:^|\s)-tags(?:=|\s+)([^\s]+)/g, (_, value) => {
  for (const tag of value.split(",")) tags.add(tag);
  return "";
});
const child = spawn("go", process.argv.slice(2), {
  stdio: "inherit",
  env: { ...(native?.env ?? process.env), GOFLAGS: `${flags} -tags=${[...tags].join(",")}`.trim() },
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => { process.exitCode = code ?? 1; });
