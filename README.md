# Pic Piper

Pic Piper is a small desktop image workbench built with Go, [MyGo](https://mygo.egoist.dev/docs), and React. This branch rebuilds the original Rust/Tauri app to evaluate native WebView packaging, build costs, and everyday usability. The first target is macOS on Apple Silicon.

## What the MVP does

- Import JPEG, PNG, WebP, AVIF, JPEG XL, and HEIF/HEIC using the file picker, native file drop, or Open With.
- Use a compact batch list with a selected-image preview, output controls, and persistent save/upload actions.
- Convert to JPEG, PNG, WebP, AVIF, or JPEG XL; choose original-format, balanced WebP, smaller AVIF, or automatic lossless presets. Lossless uses JPEG XL for ordinary stills, PNG for high-bit-depth pixels, and WebP for WebP animations.
- Resize by longest edge without cropping or enlarging small images, adjust quality, and compare full-resolution images with Fit and 100% views.
- Skip duplicate paths, stop a batch, retry unfinished images, or clear it and start again. Image jobs reuse up to two of the app's own child processes; cancel, clear, removal and superseding settings terminate old work and clean incomplete output.
- Apply EXIF orientation and strip metadata, including location data. Transparent images exported as JPEG use a white background.
- Save results to a chosen folder without overwriting existing files.
- Test an S3-compatible connection before saving, then upload, browse, download, copy public URLs, and delete objects.
- Generate object keys from a naming template and content hash. Uploads use conditional creation to avoid replacing an existing object.
- Upload originals or processed images directly from the gallery, including JPEG XL.

| Format | Import / compare | Encode / export |
| --- | --- | --- |
| JPEG, PNG | Yes | Yes |
| WebP, AVIF | Yes | Yes, with quality and transparency support |
| JPEG XL (`.jxl`) | Yes | Yes; quality 100 is lossless |
| HEIF / HEIC | HEVC still images supported by the bundled decoder | Convert to the formats above; no HEIF encoder |

PNG ignores quality and uses fast lossless compression, which can produce larger files than the default compression level. Eight-bit YCbCr sources export as 8-bit PNG; decoded 16-bit precision is retained through orientation and resizing. JPEG XL quality 100 preserves the encoder's 8-bit pixels; high-bit-depth lossless requests use PNG instead. It does not retain original JPEG bitstreams or metadata. Re-encoding can produce a larger file, and quality numbers are not equivalent across codecs.

Animated WebP output retains frames, timing, loop count and transparency, including when resized; quality 100 uses lossless WebP. Batch presets keep WebP animations in WebP. Choose a static format to explicitly confirm **Export first frame**, or use the selected image's **Animation** control; the original animation stays untouched. Detected APNG/AVIF sequences offer first-frame extraction. APNG extraction distinguishes the actual animation frame from a separate default poster and retains its canvas offset. Previews show the first frame. Preserved WebP animations are limited to 120 frames and 40 million total frame pixels.

On macOS, embedded RGB ICC profiles in JPEG/PNG/WebP and supported HEIF/AVIF color properties are normalized to sRGB with CoreGraphics before profile removal. Display P3 color conversion and alpha are regression-tested at 8 and 16 bits. PQ/HLG HDR declared by PNG cICP or HEIF/AVIF nclx is automatically tone-mapped to SDR/sRGB, with the same mapping in previews, comparisons and exports. HDR mapping supports BT.2020, Display P3 and BT.709 primaries, retains alpha and uses 16-bit intermediate pixels; the original HDR file is preserved. Unreadable profiles and unrecognized HDR primaries return an explanation. HEIF support remains limited to the HEVC still-image variants handled by the bundled decoder.

Static WebP encoding uses a pinned, statically linked libwebp 1.6.0 on native macOS/Linux builds. Other modern codec operations use the pinned Go modules and bundled implementations; the package scripts retain `nodynamic` so installed shared codec libraries do not change behavior. `CGO_ENABLED=0`, cross targets selected through GOOS/GOARCH and other platforms use the bundled WebP encoder too. No runtime Homebrew codec libraries, external encoders, or Rust toolchain are required. Codec license notices are collected into `resources/codec-notices.txt` during packaging. See [codec validation](docs/mygo-codec-results.md) for earlier checks and package costs, and [codec selection](docs/mygo-codec-selection.md) for the original implementation decisions.

## Run and build

Use Go 1.27.3 or later, Node.js, and pnpm 11.20.0. Native builds also need CMake and a C compiler (Xcode Command Line Tools on macOS; `cmake` and `build-essential` on Debian/Ubuntu). MyGo and its browser runtime are pinned to 0.9.0. Rust is not required.

The first native Go test/build downloads libwebp's official source archive, verifies its SHA-256, and builds static libraries under `.tools/native-webp/`. Later commands reuse that cache. Use `scripts/go.mjs` for Go builds and tests to select the same codecs as the packaged app; setting `CGO_ENABLED=0` explicitly selects the portable fallback. See [image pipeline performance](docs/image-pipeline-performance.md) for the changes, measurements and reproduction commands.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the desktop app and Vite. `pnpm dev:web` starts only Vite; local file and bucket operations require the desktop app.

```bash
pnpm build
```

On an Apple Silicon Mac, the packaged artifacts are:

```text
build/darwin-arm64/Pic Piper.app
build/darwin-arm64/pic-piper-0.3.0-arm64.dmg
```

Open the app directly, or open the DMG and copy the app into Applications. macOS 13 or later is required by the Go 1.27 runtime. The current package is ad-hoc signed for local evaluation; it is not notarized for public distribution. Other operating systems and Intel Macs have not been validated for this MVP.

## S3 setup and local data

1. Open Settings and enter a profile name, endpoint, region, bucket, and access key ID.
2. Enter the secret access key and use **Test connection**. Testing a draft does not save it.
3. Set path-style addressing if your provider requires it. Enter the correct endpoint and region; signed requests do not follow redirects.
4. Optionally set a public base URL and prefix, then choose **Save profile**.
5. Compress images and choose **Upload to S3**, or upload originals from S3 Gallery.

The public base URL must point to objects that are already publicly accessible. The app does not change bucket permissions or generate presigned URLs. Use HTTPS except for trusted local services.

Settings and secrets live in MyGo's user-data directory, separate from the old Tauri app. On macOS this is `~/Library/Application Support/Pic Piper/`. Credentials are plain local files, with private directory permissions and mode 0600 for secret files; they are not stored in Keychain or encrypted shared storage. Existing Tauri profiles are not imported. Optimizer cache runs older than seven days are cleaned up on a best-effort basis when creating a new run.

## Verification

```bash
pnpm test
pnpm build:web
pnpm test:go
node scripts/go.mjs test -race ./...
node scripts/go.mjs vet ./...
gofmt -l main.go main_test.go smoke.go internal scripts/icon
pnpm build
pnpm smoke
```

`pnpm smoke` launches the real packaged macOS app and drives its WebView and Go bridge. It uses private temporary app data, synthetic images, fake credentials, and a loopback S3 fixture. Reports and screenshots are saved under `build/smoke-*`. It never contacts a production bucket. It briefly checks the text clipboard and restores its previous text. Native OS file/folder dialogs and a physical Finder drag are still manual checks.

The S3 implementation uses the Go standard library with SigV4 signing. Local tests cover signing, conditional uploads, pagination, safe downloads, settings, and credentials; a live AWS/R2 account is not part of automated validation.

See [the compression workbench changes and validation](docs/image-workbench-polish.md) for the current experience and limitations. [The migration plan](docs/mygo-migration-plan.md), [framework research](docs/mygo-framework-research.md), and [MVP validation results](docs/mygo-mvp-results.md) record the earlier scope and measurements. The old `src-tauri/` tree remains as reference; current build commands do not use it.
