# Versions and releases

Pic Piper uses SemVer, Release Please, GitHub Actions and MyGo's signed updater.
The release baseline is `v1.0.0`; versions are calculated from changes merged to
`main`. The next release containing the updater is a feature release.

## Normal development

Use Conventional Commit PR titles and squash merge: `fix: …` for a repair,
`feat: …` for a compatible feature, and `feat!: …` for a breaking change.
Performance and dependency fixes can use `fix(perf): …` and `fix(deps): …`.
Pure maintenance, tests, docs and CI changes do not create a release on their own.

Release Please maintains one release PR with `package.json`, `mygo.json`, its
manifest and `CHANGELOG.md`. Review that PR's notes and version; merge it when
the accumulated changes should reach users. Do not manually bump the app files
or create the release tag.

The bot uses the repository's `GITHUB_TOKEN`. It explicitly dispatches Release
PR checks and records the result on the exact PR commit, avoiding dependence on
token-created PR event runs. GitHub may also display an approval-required event
run; the explicit `Release PR validation` status is the automated result.
No personal access token or separate hosted service is needed.

## Publishing and recovery

Merging the release PR creates a fixed `vX.Y.Z` tag and draft Release. The same
workflow invokes the build pipeline with the exact SHA. Tests, native build,
race checks and packaged GUI smoke must succeed. The pipeline verifies update
signatures, versions, release URLs and uploaded asset digests before making the
release public and setting latest. Normal PR/main builds do not get the update
private key.

To recover a failed release, run **Build and release** with the existing
`release_tag`; `release_sha` can also pin the expected commit. Continue the
existing draft. Do not move the tag. Once public, a retry leaves it unchanged.
If a source change is necessary, publish a higher version instead. An older
unresolved draft blocks a later release; explicitly mark its title with
`[abandoned]` only when that version has been intentionally cancelled.

Artifacts include a DMG, `pic-piper-X.Y.Z-darwin-arm64.tar.gz`,
`update-darwin-arm64.json`, `SHA256SUMS` and any useful delta files. Current
public releases target macOS arm64. Retain earlier archives for delta history.
The first update-enabled release may have no deltas.

## Keys and signing

`MYGO_UPDATER_PRIVATE_KEY` is a repository Actions Secret. The matching public
key is in `mygo.json`. The local backup is `.tools/update-keys/mygo-update.key`
(ignored by Git, directory mode 0700 and private file mode 0600). Back it up
privately outside this checkout before removing local tooling. Never regenerate
the production key during routine CI or put it in a release attachment.

Repository Actions must be allowed to create release PRs. Workflows retain
explicit permissions; only the final publication job writes release assets.
MyGo's update signature is separate from macOS Developer ID signing and
notarization. The current package remains ad-hoc signed until Apple credentials
are configured; do not describe it as notarized.

## Client experience and verification

Settings → General → Updates shows the running version and check/download
preferences. Preferences save immediately. Checks default to automatic; automatic
downloads are opt-in. Update windows follow the app's chosen language. A prepared
update defers restart while compression, upload or Mini tasks are active.

Users of the old Tauri app or the current release without an updater must
manually install the first update-enabled release. Later releases can update
in place. User storage profiles and credentials stay in their existing private
data directory.

For publication checks run the repository's full test/build/smoke suite and
`node --test scripts/release-checks.mjs`. The packaged app also supports an
isolated `--update-smoke <temporary-directory>` diagnostic: the app itself must
be a disposable copy inside that directory under the OS temporary directory.
Starting from a lower-version update-enabled test copy, it rejects a corrupted
signature, verifies the original executable stayed intact, installs the latest
public update and relaunches to check the new runtime version. Results go to
`update-report.json`. It does not open the user's backend or updater preferences.
