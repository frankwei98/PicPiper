import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";

const readJSON = (file) => JSON.parse(readFileSync(file, "utf8"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
export function version(value) {
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value), `Invalid stable version: ${value}`);
  return value.split(".").map(Number);
}
export function compare(a, b) {
  const x = version(a), y = version(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}
export function releaseNotes(changelog, target) {
  const headings = [...changelog.matchAll(/^## (.+)$/gm)];
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const found = heading[1].match(/^\[?v?(\d+\.\d+\.\d+)(?=\]|\s|\(|$)/);
    if (found?.[1] === target) return changelog.slice(heading.index + heading[0].length, headings[i + 1]?.index).trim();
  }
  throw new Error(`Missing changelog notes for ${target}`);
}
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gh = (...args) => run("gh", args);
const api = (path) => JSON.parse(gh("api", path));
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest();

// Publishing flips the whole draft public, not just the assets uploaded by
// this run. Reject any draft asset that was not verified against the local
// inventory.
export function unexpectedDraftAssets(assets, files) {
  const expected = new Set(files.map((file) => basename(file)));
  return assets.filter((asset) => !expected.has(asset.name)).map((asset) => asset.name);
}

function verifyDraftAssets(release, files, verifiedAssets) {
  assert(release.draft, "Release was published concurrently; stopped before further mutation");
  assert(!release.prerelease, "Stable pipeline cannot publish a prerelease");
  const unexpected = unexpectedDraftAssets(release.assets, files);
  assert(unexpected.length === 0, `Draft has assets outside the verified release inventory: ${unexpected.join(", ")}. Remove them before publishing.`);
  assert(release.assets.length === files.length, "Draft asset inventory differs from the verified release inventory");
  const assets = files.map((file) => {
    const asset = release.assets.find((entry) => entry.name === basename(file));
    assert(asset?.state === "uploaded", `Uploaded asset is not ready: ${basename(file)}`);
    return { name: asset.name, state: asset.state, size: asset.size, digest: asset.digest };
  });
  if (verifiedAssets) {
    assert(JSON.stringify(assets) === JSON.stringify(verifiedAssets), "Verified release assets changed before publishing");
    return assets;
  }
  for (const [index, file] of files.entries()) {
    assert(assets[index].size === readFileSync(file).length && assets[index].digest === `sha256:${digest(file).toString("hex")}`, `Uploaded asset did not match: ${basename(file)}`);
  }
  return assets;
}

const platforms = {
  "darwin-arm64": { runner: "macos-15", cgo: "1" },
  "windows-amd64": { runner: "windows-2025", cgo: "0" },
  "windows-arm64": { runner: "windows-11-arm", cgo: "0" },
  "linux-amd64": { runner: "ubuntu-24.04", cgo: "1" },
  "linux-arm64": { runner: "ubuntu-24.04-arm", cgo: "1" },
};

// Read the release source's inventory, so recovery of an older macOS-only tag
// does not require packages that were never part of that version.
export function configuredTargets(directory = ".") {
  const file = resolve(directory, ".release-targets.json");
  const targets = existsSync(file) ? readJSON(file) : ["darwin-arm64"];
  assert(Array.isArray(targets) && targets.length > 0 && new Set(targets).size === targets.length, "Invalid release target inventory");
  assert(targets.every((target) => Object.hasOwn(platforms, target)), "Unsupported release target");
  return targets;
}

export function buildMatrix(targets) {
  return { include: targets.map((target) => ({ target, ...platforms[target] })) };
}

function targetArtifacts(directory, app, repository, target) {
  assert(Object.hasOwn(platforms, target), "Unsupported release target");
  const manifestPath = resolve(directory, `update-${target}.json`);
  const manifest = readJSON(manifestPath);
  assert(manifest.version === app.version, "Update manifest version differs from app version");
  assert(manifest.notes?.trim(), "Update has no release notes");
  const prefix = `https://github.com/${repository}/releases/download/v${app.version}/`;
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(app.updates.publicKey, "base64")]), format: "der", type: "spki" });
  const files = [manifestPath];
  for (const entry of [manifest, ...(manifest.deltas ?? [])]) {
    assert(typeof entry.url === "string" && entry.url.startsWith(prefix), "Update URL is outside this version's release");
    const name = entry.url.slice(prefix.length);
    assert(name === basename(name) && !/[\\%?#]/.test(name), "Invalid update asset name");
    assert(name.endsWith(`-${target}${entry === manifest ? ".tar.gz" : ".delta"}`), "Update asset belongs to another target");
    const path = resolve(directory, name);
    assert(readFileSync(path).length === entry.size, `Wrong size for ${name}`);
    assert(verify(null, digest(path), key, Buffer.from(entry.signature, "base64")), `Invalid signature for ${name}`);
    files.push(path);
  }
  assert(basename(files[1]) === `${app.slug}-${app.version}-${target}.tar.gz`, "Wrong full update archive");
  const [system, arch] = target.split("-");
  const installers = system === "darwin" ? [`${app.slug}-${app.version}-${arch}.dmg`]
    : system === "windows" ? [`${app.slug}-setup-${app.version}-${arch}.exe`]
    : [`${app.slug}_${app.version}_${arch}.deb`, `${app.slug}-${app.version}-1.${arch === "amd64" ? "x86_64" : "aarch64"}.rpm`];
  for (const name of installers) {
    const installer = resolve(directory, name);
    assert(existsSync(installer), `Missing installer: ${name}`);
    files.push(installer);
  }
  return files;
}

export function releaseArtifacts(directory, app, repository, targets) {
  const files = targets.flatMap((target) => targetArtifacts(directory, app, repository, target));
  assert(new Set(files.map((file) => basename(file))).size === files.length, "Release assets have conflicting names");
  const sums = resolve(directory, "SHA256SUMS");
  writeFileSync(sums, files.map((file) => `${digest(file).toString("hex")}  ${basename(file)}\n`).join(""));
  return [...files, sums];
}

export function artifacts(directory, app, repository, target = "darwin-arm64") {
  return releaseArtifacts(directory, app, repository, [target]);
}

async function main() {
  const [operation, tag, expectedSHA, target = "darwin-arm64"] = process.argv.slice(2);
  const app = readJSON("mygo.json");
  const pkg = readJSON("package.json");
  const ledger = readJSON(".release-please-manifest.json");
  version(app.version);
  assert(pkg.version === app.version && ledger["."] === app.version, "Application versions are out of sync");
  const notes = releaseNotes(readFileSync("CHANGELOG.md", "utf8"), app.version);
  assert(notes, "Empty release notes");
  const targets = configuredTargets();
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(buildMatrix(targets))}\n`);
  if (operation === "metadata") return;
  assert(tag === `v${app.version}`, "Release tag differs from app version");
  const sha = run("git", ["rev-parse", "HEAD"]);
  assert(run("git", ["rev-parse", `${tag}^{commit}`]) === sha, "Tag does not identify the checked-out source");
  if (expectedSHA) assert(sha === expectedSHA, "Release source changed");
  const repository = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  assert(repository === app.updates.github, "Release repository differs from the embedded update feed");
  if (operation === "source") {
    // The tag endpoint only exposes published releases. A draft is expected
    // to return 404 to this read-only job; validate its git identity above.
    let published = false;
    try {
      const release = api(`repos/${repository}/releases/tags/${tag}`);
      assert(!release.prerelease, "Stable pipeline cannot publish a prerelease");
      published = !release.draft;
    } catch (error) {
      if (!String(error.stderr).includes("HTTP 404")) throw error;
    }
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\npublished=${published}\n`);
    return;
  }
  if (operation === "artifacts") {
    assert(targets.includes(target), "Target is not part of this release");
    artifacts(resolve("build", target), app, repository, target);
    return;
  }
  assert(operation === "publish", "Unknown release command");
  const directory = process.env.RELEASE_ASSET_DIR || (existsSync(".release-targets.json") ? "build/release-assets" : "build/darwin-arm64");
  const files = releaseArtifacts(resolve(directory), app, repository, targets);
  // This job alone has write access and can enumerate private drafts. Use
  // the release ID for refreshes rather than the published-only tag route.
  const all = api(`repos/${repository}/releases?per_page=100`);
  const release = all.find((item) => item.tag_name === tag);
  assert(release, `Missing release draft for ${tag}`);
  assert(!release.prerelease, "Stable pipeline cannot publish a prerelease");
  // Published releases are immutable. A retry verifies their required asset
  // inventory but never uploads replacement files or changes latest.
  if (!release.draft) {
    const required = files.map((file) => basename(file));
    assert(required.every((name) => release.assets.some((asset) => asset.name === name && asset.state === "uploaded")), "Published release is missing required assets; repair with a new version");
    console.log(`${tag} is already published; left unchanged.`);
    return;
  }
  const olderDraft = all.find((item) => item.draft && item.tag_name !== tag && /^v\d+\.\d+\.\d+$/.test(item.tag_name) && compare(item.tag_name.slice(1), app.version) < 0 && !item.name?.startsWith("[abandoned]"));
  assert(!olderDraft, `Resolve the older draft ${olderDraft?.tag_name} before publishing`);
  const stable = all.filter((item) => !item.draft && !item.prerelease && /^v\d+\.\d+\.\d+$/.test(item.tag_name));
  assert(stable.every((item) => compare(app.version, item.tag_name.slice(1)) > 0), "A newer or equal stable release already exists");
  gh("release", "upload", tag, ...files, "--clobber", "--repo", repository);
  const uploaded = api(`repos/${repository}/releases/${release.id}`);
  const verifiedAssets = verifyDraftAssets(uploaded, files);
  // Recheck as late as possible: releases/{id} is a snapshot, and other writers
  // can change the draft while local hashes and the asset inventory are checked.
  const beforePublish = api(`repos/${repository}/releases/${release.id}`);
  assert(beforePublish.id === uploaded.id, "Release identity changed before publishing");
  verifyDraftAssets(beforePublish, files, verifiedAssets);
  gh("release", "edit", tag, "--draft=false", "--latest", "--repo", repository);
  console.log(`Published ${tag}: ${files.length} verified assets from ${sha}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
