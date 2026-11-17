import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { artifacts, buildMatrix, compare, configuredTargets, releaseArtifacts, releaseNotes, version } from "./release.mjs";

test("stable versions compare numerically and reject malformed release identifiers", () => {
  assert.equal(compare("1.10.0", "1.9.9"), 1);
  assert.equal(compare("1.0.1", "1.0.1"), 0);
  for (const invalid of ["v1.0.0", "01.0.0", "1.0.0-beta.1", "1.0.0+build.2", "../main"]) assert.throws(() => version(invalid));
});

function writeTargetAssets(directory, target, appVersion, privateKey) {
  const name = `pic-piper-${appVersion}-${target}.tar.gz`;
  const body = Buffer.from(`synthetic signed update for ${target}`);
  writeFileSync(join(directory, name), body);
  const [system, arch] = target.split("-");
  const installers = system === "darwin" ? [`pic-piper-${appVersion}-${arch}.dmg`]
    : system === "windows" ? [`pic-piper-setup-${appVersion}-${arch}.exe`]
    : [`pic-piper_${appVersion}_${arch}.deb`, `pic-piper-${appVersion}-1.${arch === "amd64" ? "x86_64" : "aarch64"}.rpm`];
  for (const file of installers) writeFileSync(join(directory, file), `synthetic ${target} installer`);
  const manifest = { version: appVersion, notes: "Signed updates", url: `https://github.com/example/app/releases/download/v${appVersion}/${name}`, size: body.length, signature: sign(null, createHash("sha256").update(body).digest(), privateKey).toString("base64") };
  writeFileSync(join(directory, `update-${target}.json`), JSON.stringify(manifest));
}

function releaseCLI(targets) {
  const dir = mkdtempSync(join(tmpdir(), "picpiper-draft-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const sha = "a".repeat(40);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const app = { slug: "pic-piper", version: "1.1.0", updates: { github: "example/app", publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") } };
  for (const [name, value] of Object.entries({ "mygo.json": app, "package.json": { version: app.version }, ".release-please-manifest.json": { ".": app.version } })) writeFileSync(join(dir, name), JSON.stringify(value));
  writeFileSync(join(dir, "CHANGELOG.md"), "## 1.1.0\n\nSigned updates\n");
  writeFileSync(join(dir, "release.json"), JSON.stringify({ id: 101, tag_name: "v1.1.0", draft: true, prerelease: false, assets: [] }));
  if (targets) writeFileSync(join(dir, ".release-targets.json"), JSON.stringify(targets));
  const assets = join(dir, targets ? "build/release-assets" : "build/darwin-arm64");
  mkdirSync(assets, { recursive: true });
  for (const target of targets || ["darwin-arm64"]) writeTargetAssets(assets, target, app.version, privateKey);
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
  const reads = Number(fs.existsSync('release-reads') ? fs.readFileSync('release-reads','utf8') : 0) + 1;
  fs.writeFileSync('release-reads',String(reads));
  if (reads === 1 && process.env.RELEASE_FIXTURE_MUTATION) {
    if (process.env.RELEASE_FIXTURE_MUTATION === 'late-asset') release.assets.push({name:'late.zip',state:'uploaded',size:1,digest:'sha256:late'});
    if (process.env.RELEASE_FIXTURE_MUTATION === 'published') release.draft = false;
    if (process.env.RELEASE_FIXTURE_MUTATION === 'changed-asset') release.assets[0].digest = 'sha256:changed';
    fs.writeFileSync('release.json',JSON.stringify(release));
  }
} else if (args[0] === 'release' && args[1] === 'upload') {
  release.assets = args.slice(3).filter(x => path.isAbsolute(x)).map(file => ({name:path.basename(file), state:'uploaded', size:fs.statSync(file).size, digest:'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
  fs.writeFileSync('release.json',JSON.stringify(release));
} else if (args[0] === 'release' && args[1] === 'edit') {
  release.draft = false; fs.writeFileSync('release.json',JSON.stringify(release));
} else { console.error('Unexpected request'); process.exit(1); }
`, { mode: 0o755 });
  return {
    dir,
    assets,
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

test("target inventory retains old tags and rejects unsupported or duplicate targets", () => {
  const dir = mkdtempSync(join(tmpdir(), "picpiper-targets-"));
  try {
    assert.deepEqual(configuredTargets(dir), ["darwin-arm64"]);
    const targets = ["darwin-arm64", "windows-amd64", "windows-arm64", "linux-amd64", "linux-arm64"];
    const file = join(dir, ".release-targets.json");
    writeFileSync(file, JSON.stringify(targets));
    assert.deepEqual(configuredTargets(dir), targets);
    const matrix = buildMatrix(configuredTargets(dir));
    assert.equal(matrix.include.find((item) => item.target === "windows-arm64").runner, "windows-11-arm");
    assert.equal(matrix.include.find((item) => item.target === "linux-arm64").runner, "ubuntu-24.04-arm");
    assert.equal(matrix.include.find((item) => item.target === "windows-amd64").cgo, "0");
    for (const invalid of [[], ["linux-amd64", "linux-amd64"], ["windows-x64"], ["../windows-amd64"], { target: "linux-amd64" }]) {
      writeFileSync(file, JSON.stringify(invalid));
      assert.throws(() => configuredTargets(dir), /target/i);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("publication requires every configured platform before uploading and includes one combined checksum file", () => {
  const targets = ["darwin-arm64", "windows-amd64", "windows-arm64", "linux-amd64", "linux-arm64"];
  const fixture = releaseCLI(targets);
  try {
    const installer = join(fixture.assets, "pic-piper_1.1.0_arm64.deb");
    const body = readFileSync(installer);
    rmSync(installer);
    assert.throws(() => fixture.run("publish"), /Missing installer/);
    assert.equal(existsSync(join(fixture.dir, "requests.log")), false);
    writeFileSync(installer, body);
    fixture.run("publish");
    const published = JSON.parse(readFileSync(join(fixture.dir, "release.json"), "utf8"));
    assert.equal(published.draft, false);
    assert.equal(published.assets.length, 18);
    for (const target of targets) assert(published.assets.some((asset) => asset.name === `update-${target}.json`));
    const sums = readFileSync(join(fixture.assets, "SHA256SUMS"), "utf8").trim().split("\n");
    assert.equal(sums.length, 17);
    for (const line of sums) {
      const [hash, name] = line.split("  ");
      assert.equal(createHash("sha256").update(readFileSync(join(fixture.assets, name))).digest("hex"), hash);
    }
    fixture.run("publish");
    const requests = readFileSync(join(fixture.dir, "requests.log"), "utf8");
    assert.equal(requests.match(/"upload"/g)?.length, 1);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a valid signature cannot substitute another platform's archive or delta", () => {
  const dir = mkdtempSync(join(tmpdir(), "picpiper-platform-"));
  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const app = { slug: "pic-piper", version: "1.1.0", updates: { publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") } };
    writeTargetAssets(dir, "windows-arm64", app.version, privateKey);
    writeTargetAssets(dir, "linux-arm64", app.version, privateKey);
    const file = join(dir, "update-windows-arm64.json");
    const original = JSON.parse(readFileSync(file, "utf8"));
    const other = JSON.parse(readFileSync(join(dir, "update-linux-arm64.json"), "utf8"));
    writeFileSync(file, JSON.stringify(other));
    assert.throws(() => artifacts(dir, app, "example/app", "windows-arm64"), /another target/);
    writeFileSync(file, JSON.stringify({ ...original, deltas: [other] }));
    assert.throws(() => artifacts(dir, app, "example/app", "windows-arm64"), /another target/);
    writeFileSync(file, JSON.stringify(original));
    assert.equal(releaseArtifacts(dir, app, "example/app", ["windows-arm64", "linux-arm64"]).length, 8);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test("publishing rechecks the release after asset verification before making it public", () => {
  for (const mutation of ["late-asset", "published", "changed-asset"]) {
    const fixture = releaseCLI();
    try {
      assert.throws(() => fixture.run("publish", { RELEASE_FIXTURE_MUTATION: mutation }));
      const requests = readFileSync(join(fixture.dir, "requests.log"), "utf8");
      assert.equal(requests.match(/"edit"/g)?.length ?? 0, 0, `${mutation}: release was edited`);
      assert.equal(requests.match(/releases\/101/g)?.length, 2, `${mutation}: final release state was not fetched`);
    } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
  }
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
