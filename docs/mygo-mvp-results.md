# Go + MyGo JPEG/PNG baseline evaluation

This report preserves the first JPEG/PNG MVP measurements. WebP, AVIF, JPEG XL, and HEIC import have since been added; see [current codec results](mygo-codec-results.md) for the expanded format support and current artifact sizes. The current artifact paths below now contain that newer build.

Measured on 2026-11-11 on macOS arm64, Darwin 27.2.0, using Go 1.27.3, Node 26.13.0, pnpm 11.20.0, and MyGo 0.9.0.

The rebuild produces a usable local JPEG/PNG preparation and S3 sharing app. The complete packaged application is about 12.8 MB, meeting the initial two-digit-MB exploration target. This establishes the current macOS MVP's size, rather than a general guarantee about MyGo or future codecs.

## Artifacts and build measurements

| Measurement | Result | Scope |
| --- | --- | --- |
| Complete `.app` | approximately 12.8 MB / 12.2 MiB | Executable, embedded React UI, icon, resources, ad-hoc signature |
| Executable | approximately 12.7 MB / 12.1 MiB | Includes frontend assets and the opt-in smoke driver |
| DMG | approximately 3.76 MB / 3.58 MiB | Compressed local installation artifact |
| Frontend production files | approximately 413 KB | Uncompressed files in `dist/` |
| Full warm build | 7.91–9.17 seconds across two measured runs | `/usr/bin/time -l pnpm build`, including generation, frontend, Go compilation, signing, and DMG creation; final build 9.17 seconds |
| MyGo's own timer in the final run | 7.1 seconds | Frontend 2.1 seconds, Go compilation 576 ms, DMG 3.7 seconds |

Artifacts are `build/darwin-arm64/Pic Piper.app` and `build/darwin-arm64/pic-piper-0.3.0-arm64.dmg`. Size units above explicitly distinguish decimal MB from binary MiB. Timing is machine- and cache-dependent. Cold builds and app runtime memory were not measured.

The project-local `build/` folder was about 31 MiB during evaluation, including multiple diagnostic screenshots and temporary smoke data; `dist/` was 416 KiB and `node_modules/` 264 MiB. No `.mygo/` folder or `src-tauri/target/` build output was present. The existing shared Go compilation cache was 607 MiB and the shared module directory 823 MiB. Those shared totals include other work and are **not** measurements of this project's incremental cache growth. No global caches were deleted.

There is no measured old Tauri `.app` or Rust cold-build baseline, so this evaluation does not claim a numeric size or disk reduction against the old implementation. No Rust installation, compilation, or tests were required for the new build.

## Verified behavior

The macOS packaged-app driver launches the real `.app` through Launch Services and operates the actual WebView, generated MyGo bindings, and Go backend. It completed:

1. Load the embedded frontend and native runtime.
2. Fill the settings form, test a draft connection against a loopback S3 fixture, and save a profile.
3. Import a synthetic 1200 × 800 JPEG through the native image-open event and complete compression. The fixture changed from about 188 KiB to 60 KiB at quality 85; this is one fixture, not a quality benchmark.
4. Open comparison and render both full-resolution images.
5. Export through the bound Go service and verify the disk file.
6. Upload through the UI, retain local results, and open the uploaded objects in the gallery.
7. Download through the native bridge and compare bytes with the uploaded object.
8. Copy the public URL through the native clipboard, then restore the previous clipboard text.
9. Confirm deletion in the UI and verify the fixture bucket is empty.
10. Resize to 920 × 600 and verify the compression actions remain inside the viewport.

Screenshots cover the initial workspace, saved settings, compressed result, comparison, gallery, minimum window, and light theme. `pnpm smoke` prints the directory containing `report.json` and these PNGs. Screenshots were opened and visually inspected during evaluation.

Unattended macOS launches in this environment leave WebView animation frames paused even after focus requests. Smoke mode disables CSS animation and uses a timer-backed animation-frame callback so component presence transitions and screenshots settle. This is injected only by `--smoke-test`; normal app behavior is unchanged. This driver verifies application behavior and rendered content, not foreground animation smoothness.

## Regression checks

- Frontend: 13 Vitest files, 125 tests.
- Go image tests: orientation transforms, metadata stripping, PNG alpha/JPEG white matte, corrupt and oversized images, filenames, cache containment, concurrent non-overwriting exports, thumbnails, and comparison.
- Go cloud tests: deterministic SigV4 signature, settings/credential persistence and permissions, pagination, conditional conflicts, key/URL encoding, naming, and safe downloads.
- Native bridge tests: concurrent launch-file handoff without loss/duplication, and preservation of structured business errors.
- `go test ./...`, `go test -race ./...`, `go vet ./...`, formatting, and `git diff --check`.
- `pnpm build` includes TypeScript checking and the production Vite build.
- `codesign --verify --deep --strict` validates the local app signature.

The signing fixture's expected HMAC was independently computed. The local S3 fixture checks request shape and conditional creation; it is not an independent implementation of all AWS signature validation. CI configuration now gates packaging on frontend and Go checks, then runs packaged smoke on macOS; remote CI execution has not been observed in this session.

## MVP boundaries

- Image processing supports JPEG and PNG. PNG encoding is lossless and can increase size. JPEG flattens transparency onto white. WebP/AVIF/HEIF/HEIC originals can be uploaded from the gallery but cannot be compressed here.
- Only macOS arm64 packaging and runtime were exercised. Intel macOS, Windows, and Linux remain follow-up targets.
- OS file/folder picker interaction and a physical Finder drag were not automated. The actual file-open event subscription, processing, export service, and download service were exercised; launch-file buffering also has a concurrency regression test.
- No live AWS, R2, B2, or MinIO service was contacted. Production-provider interoperability still requires a real account check with the correct endpoint, region, addressing mode, and permissions.
- Credentials are private plain local files, with mode 0600 and private directories on this platform. They are not Keychain entries. The app uses `~/Library/Application Support/Pic Piper/`; old Tauri settings are not imported.
- Packages are ad-hoc signed and not notarized. They are intended for local evaluation; no release was published.

The next useful evaluation is daily use with representative personal JPEG/PNG images and one real S3-compatible profile, followed by a measured WebP codec choice. More codecs and platform builds should carry their own size, quality, build-time, and dependency measurements.
