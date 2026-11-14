import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") {
  console.log("Native status-icon drop tests require macOS.");
  process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), "pic-piper-tray-test-"));
try {
  const executable = join(directory, "native-drop-test");
  execFileSync("/usr/bin/clang", [
    "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter",
    "-framework", "Cocoa", resolve("internal/traydrop/testdata/native.m"),
    "-o", executable,
  ], { stdio: "inherit" });
  execFileSync(executable, [], { stdio: "inherit", timeout: 10_000 });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
