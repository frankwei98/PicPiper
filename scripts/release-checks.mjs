import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { artifacts, compare, releaseNotes, version } from "./release.mjs";

test("stable versions compare numerically and reject malformed release identifiers", () => {
  assert.equal(compare("1.10.0", "1.9.9"), 1);
  assert.equal(compare("1.0.1", "1.0.1"), 0);
  for (const invalid of ["v1.0.0", "01.0.0", "1.0.0-beta.1", "1.0.0+build.2", "../main"]) assert.throws(() => version(invalid));
});

function releaseCLI() {
  const dir = mkdtempSync(join(tmpdir(), "picpiper-draft-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const sha = "a".repeat(40);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const app = { slug: "pic-piper", version: "1.1.0", updates: { github: "example/app", publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") } };
  for (const [name, value] of Object.entries({ "mygo.json": app, "package.json": { version: app.version }, ".release-please-manifest.json": { ".": app.version } })) writeFileSync(join(dir, name), JSON.stringify(value));
  writeFileSync(join(dir, "CHANGELOG.md"), "## 1.1.0\n\nSigned updates\n");
  writeFileSync(join(dir, "release.json"), JSON.stringify({ id: 101, tag_name: "v1.1.0", draft: true, prerelease: false, assets: [] }));
  const assets = join(dir, "build/darwin-arm64");
  mkdirSync(assets, { recursive: true });
  const name = "pic-piper-1.1.0-darwin-arm64.tar.gz";
  const body = Buffer.from("synthetic signed update");
  writeFileSync(join(assets, name), body);
  writeFileSync(join(assets, "pic-piper-1.1.0-arm64.dmg"), "synthetic installer");
  writeFileSync(join(assets, "update-darwin-arm64.json"), JSON.stringify({ version: app.version, notes: "Signed updates", url: `https://github.com/example/app/releases/download/v1.1.0/${name}`, size: body.length, signature: sign(null, createHash("sha256").update(body).digest(), privateKey).toString("base64") }));
  writeFileSync(join(bin, "git"), `#!${process.execPath}\nconsole.log('${sha}');\n`, { mode: 0o755 });
  writeFileSync(join(bin, "gh"), `#!${process.execPath}
const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync('requests.log', JSON.stringify(args)+'\\n');
const release = JSON.parse(fs.readFileSync('release.json','utf8'));
if (args[0] === 'api' && args[1].includes('/releases/tags/')) {
  if (process.env.RELEASE_FIXTURE_HTTP) {
    console.error('gh: API error (HTTP '+process.env.RELEASE_FIXTURE_HTTP+')'); process.exit(1);
  }
  if (release.draft) { console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
  console.log(JSON.stringify(release)); process.exit(0);
}
if (args[0] === 'api' && args[1].endsWith('/releases?per_page=100')) {
  console.log(JSON.stringify([release]));
} else if (args[0] === 'api' && args[1].endsWith('/releases/101')) {
  console.log(JSON.stringify(release));
} else if (args[0] === 'release' && args[1] === 'upload') {
  release.assets = args.slice(3).filter(x => path.isAbsolute(x)).map(file => ({name:path.basename(file), state:'uploaded', size:fs.statSync(file).size, digest:'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
  fs.writeFileSync('release.json',JSON.stringify(release));
} else if (args[0] === 'release' && args[1] === 'edit') {
  release.draft = false; fs.writeFileSync('release.json',JSON.stringify(release));
} else { console.error('Unexpected request'); process.exit(1); }
`, { mode: 0o755 });
  return {
    dir,
    run: (operation, env = {}) => execFileSync(process.execPath, [fileURLToPath(new URL("./release.mjs", import.meta.url)), operation, "v1.1.0", sha], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_REPO: "example/app", GITHUB_OUTPUT: join(dir, "outputs"), ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  };
}

test("read-only source validation accepts a tagged draft whose tag endpoint returns 404", () => {
  const fixture = releaseCLI();
  try {
    fixture.run("source");
    assert.match(readFileSync(join(fixture.dir, "outputs"), "utf8"), /published=false/);
    assert.throws(() => fixture.run("source", { RELEASE_FIXTURE_HTTP: "403" }), /HTTP 403/);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("publishing finds drafts through the release list, verifies by ID, and retries without mutation", () => {
  const fixture = releaseCLI();
  try {
    fixture.run("publish");
    assert.equal(JSON.parse(readFileSync(join(fixture.dir, "release.json"), "utf8")).draft, false);
    const before = readFileSync(join(fixture.dir, "requests.log"), "utf8");
    assert.match(before, /releases\/101/);
    assert.doesNotMatch(before, /releases\/tags/);
    fixture.run("publish");
    const after = readFileSync(join(fixture.dir, "requests.log"), "utf8");
    assert.equal(after.match(/"upload"/g)?.length, 1);
    assert.equal(after.match(/"edit"/g)?.length, 1);
    fixture.run("source");
    assert.match(readFileSync(join(fixture.dir, "outputs"), "utf8"), /published=true/);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
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
