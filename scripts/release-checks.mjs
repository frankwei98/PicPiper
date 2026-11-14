import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifacts, compare, releaseNotes, version } from "./release.mjs";

test("stable versions compare numerically and reject malformed release identifiers", () => {
  assert.equal(compare("1.10.0", "1.9.9"), 1);
  assert.equal(compare("1.0.1", "1.0.1"), 0);
  for (const invalid of ["v1.0.0", "01.0.0", "1.0.0-beta.1", "1.0.0+build.2", "../main"]) assert.throws(() => version(invalid));
});
test("release notes select only the requested section in Release Please format", () => {
  const text = "# Changelog\n\n## [1.10.0](https://example.test)\n\nnewer\n\n## [1.1.0](https://example.test) (2026-11-14)\n\n### Features\n- update\n\n## 1.0.0\nold";
  assert.equal(releaseNotes(text, "1.1.0"), "### Features\n- update");
  assert.throws(() => releaseNotes(text, "2.0.0"));
});
test("release assets reject tampering, wrong targets and downloads outside the tagged release", () => {
  const dir = mkdtempSync(join(tmpdir(), "picpiper-release-"));
  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const rawKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    const app = { slug: "pic-piper", version: "1.1.0", updates: { publicKey: rawKey } };
    const archive = "pic-piper-1.1.0-darwin-arm64.tar.gz";
    const body = Buffer.from("synthetic signed archive");
    const manifest = { version: "1.1.0", notes: "Updates", size: body.length, url: `https://github.com/example/app/releases/download/v1.1.0/${archive}`, signature: sign(null, createHash("sha256").update(body).digest(), privateKey).toString("base64") };
    const save = () => writeFileSync(join(dir, "update-darwin-arm64.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, archive), body);
    writeFileSync(join(dir, "pic-piper-1.1.0-arm64.dmg"), "synthetic installer");
    save();
    assert.equal(artifacts(dir, app, "example/app").length, 4);
    writeFileSync(join(dir, archive), Buffer.alloc(body.length));
    assert.throws(() => artifacts(dir, app, "example/app"), /signature/);
    writeFileSync(join(dir, archive), body);
    manifest.url = `https://example.test/${archive}`;
    save();
    assert.throws(() => artifacts(dir, app, "example/app"), /outside/);
    manifest.version = "1.2.0";
    save();
    assert.throws(() => artifacts(dir, app, "example/app"), /version/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
