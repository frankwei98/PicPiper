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

export function artifacts(directory, app, repository) {
  const target = "darwin-arm64";
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
    assert(name === basename(name) && !name.includes("%") && !name.includes("?"), "Invalid update asset name");
    const path = resolve(directory, name);
    assert(readFileSync(path).length === entry.size, `Wrong size for ${name}`);
    assert(verify(null, digest(path), key, Buffer.from(entry.signature, "base64")), `Invalid signature for ${name}`);
    files.push(path);
  }
  assert(basename(files[1]) === `${app.slug}-${app.version}-${target}.tar.gz`, "Wrong full update archive");
  const dmg = resolve(directory, `${app.slug}-${app.version}-arm64.dmg`);
  assert(existsSync(dmg), "Missing DMG");
  files.push(dmg);
  const sums = resolve(directory, "SHA256SUMS");
  writeFileSync(sums, files.map((file) => `${digest(file).toString("hex")}  ${basename(file)}\n`).join(""));
  return [...files, sums];
}

async function main() {
  const [operation, tag, expectedSHA] = process.argv.slice(2);
  const app = readJSON("mygo.json");
  const pkg = readJSON("package.json");
  const ledger = readJSON(".release-please-manifest.json");
  version(app.version);
  assert(pkg.version === app.version && ledger["."] === app.version, "Application versions are out of sync");
  const notes = releaseNotes(readFileSync("CHANGELOG.md", "utf8"), app.version);
  assert(notes, "Empty release notes");
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
  const files = artifacts(resolve("build/darwin-arm64"), app, repository);
  if (operation === "artifacts") return;
  assert(operation === "publish", "Unknown release command");
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
  assert(uploaded.draft, "Release was published concurrently; stopped before further mutation");
  for (const file of files) {
    const asset = uploaded.assets.find((entry) => entry.name === basename(file));
    assert(asset?.state === "uploaded" && asset.size === readFileSync(file).length && asset.digest === `sha256:${digest(file).toString("hex")}`, `Uploaded asset did not match: ${basename(file)}`);
  }
  gh("release", "edit", tag, "--draft=false", "--latest", "--repo", repository);
  console.log(`Published ${tag}: ${files.length} verified assets from ${sha}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
