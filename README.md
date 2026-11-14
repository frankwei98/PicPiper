# Pic Piper

Pic Piper is a small desktop image workbench built with Go, [MyGo](https://mygo.egoist.dev/docs), and React, with batch compression, full-resolution comparisons, and S3-compatible storage. The first target is macOS on Apple Silicon.

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
- Follow the system language or choose Simplified Chinese, English, French, Spanish, Japanese, or Korean in Settings. Language changes apply immediately and are remembered on this device.

| Format | Import / compare | Encode / export |
| --- | --- | --- |
| JPEG, PNG | Yes | Yes |
| WebP, AVIF | Yes | Yes, with quality and transparency support |
| JPEG XL (`.jxl`) | Yes | Yes; quality 100 is lossless |
| HEIF / HEIC | HEVC still images supported by the bundled decoder | Convert to the formats above; no HEIF encoder |

PNG ignores quality and uses fast lossless compression, which can produce larger files than the default compression level. Eight-bit YCbCr sources export as 8-bit PNG; decoded 16-bit precision is retained through orientation and resizing. JPEG XL quality 100 preserves the encoder's 8-bit pixels; high-bit-depth lossless requests use PNG instead. It does not retain original JPEG bitstreams or metadata. Re-encoding can produce a larger file, and quality numbers are not equivalent across codecs.

Animated WebP output retains frames, timing, loop count and transparency, including when resized; quality 100 uses lossless WebP. Batch presets keep WebP animations in WebP. Choose a static format to explicitly confirm **Export first frame**, or use the selected image's **Animation** control; the original animation stays untouched. Detected APNG/AVIF sequences offer first-frame extraction. APNG extraction distinguishes the actual animation frame from a separate default poster and retains its canvas offset. Previews show the first frame. Preserved WebP animations are limited to 120 frames and 40 million total frame pixels.

On macOS, embedded RGB ICC profiles in JPEG/PNG/WebP and supported HEIF/AVIF color properties are normalized to sRGB with CoreGraphics before profile removal. Display P3 color conversion and alpha are regression-tested at 8 and 16 bits. PQ/HLG HDR declared by PNG cICP or HEIF/AVIF nclx is automatically tone-mapped to SDR/sRGB, with the same mapping in previews, comparisons and exports. HDR mapping supports BT.2020, Display P3 and BT.709 primaries, retains alpha and uses 16-bit intermediate pixels; the original HDR file is preserved. Unreadable profiles and unrecognized HDR primaries return an explanation. HEIF support remains limited to the HEVC still-image variants handled by the bundled decoder.

Still-image WebP and AVIF encoding use pinned, statically linked libraries on native macOS/Linux builds: libwebp 1.6.0 and libavif 1.4.2/libaom 3.14.1. AVIF keeps 8-bit 4:4:4 color and the requested quality, uses speed 6 for better compression, and preserves lossless alpha with extra search on the alpha plane. Each native AVIF encoder uses at most two threads. Other modern codec operations use the pinned Go modules and bundled implementations; the package scripts retain `nodynamic` so installed shared codec libraries do not change behavior. `CGO_ENABLED=0`, cross targets selected through GOOS/GOARCH and other platforms use bundled encoders. Portable AVIF also uses speed 6 but is slower and retains the wrapper's alpha conversion. No runtime Homebrew codec libraries, external encoders, or Rust toolchain are required. Codec license notices are collected into `resources/codec-notices.txt` during packaging. See [AVIF tuning](docs/avif-performance.md) for measurements, [codec validation](docs/mygo-codec-results.md) for earlier checks, and [codec selection](docs/mygo-codec-selection.md) for the original decisions.

## Run and build

Use Go 1.27.3 or later, Node.js, and pnpm 11.20.0. Native builds also need CMake, pkg-config, and C/C++ compilers (Xcode Command Line Tools plus CMake/pkg-config on macOS; `cmake`, `pkg-config`, and `build-essential` on Debian/Ubuntu). Native x86-64 AVIF builds also require NASM (`nasm`). MyGo and its browser runtime are pinned to 0.9.0. Rust is not required.

The first native Go test/build downloads the pinned WebP, libavif and libaom source archives, verifies their SHA-256 hashes, and builds static libraries under `.tools/native-webp/` and `.tools/native-avif/`. Later commands reuse those caches. Use `scripts/go.mjs` for Go builds and tests to select the same codecs as the packaged app; setting `CGO_ENABLED=0` explicitly selects the portable fallback. See [image pipeline performance](docs/image-pipeline-performance.md) and [AVIF tuning](docs/avif-performance.md) for measurements and reproduction commands.

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
build/darwin-arm64/pic-piper-1.0.0-arm64.dmg
```

Open the app directly, or open the DMG and copy the app into Applications. macOS 13 or later is required by the Go 1.27 runtime. The current package is ad-hoc signed for local evaluation; it is not notarized for public distribution. Other operating systems and Intel Macs have not been validated for this MVP.

## Updates and releases

Use **Settings → General → Updates** or the application menu to check for updates.
Installed builds check automatically; automatic downloads are optional. Updates
are verified with the application's update signing key and run after restart.
An update waits for active compression, upload and Mini tasks before quitting.
Development builds and read-only installation locations cannot update in place.

Versions and changelogs are maintained by Release Please. Merge its release PR
to publish the accumulated changes after automated tests, packaging and GUI
smoke pass. See [release operations](docs/releasing.md) for version rules, signed
assets, key backup and failed-release recovery. Users of releases without an
updater need to install the first update-enabled version manually.

## Language

Use **Settings → Language** to choose a language or follow the system. Unsupported system languages fall back to English; regional Chinese variants currently use Simplified Chinese. The language preference is stored separately from S3 profiles and does not require saving a profile. Backend and operating-system diagnostic details can still appear in their original language. See [localization development](src/i18n/README.md) for message catalogs and adding languages.

## S3 setup and local data

1. Open Settings and enter a profile name, endpoint, region, bucket, and access key ID.
2. Enter the secret access key and use **Test connection**. Testing a draft does not save it.
3. Set path-style addressing if your provider requires it. Enter the correct endpoint and region; signed requests do not follow redirects.
4. Optionally set a public base URL and prefix, then choose **Save profile**.
5. Compress images and choose **Upload to S3**, or upload originals from S3 Gallery.

The S3 gallery currently shows only images uploaded by Pic Piper on this device. Successful uploads are recorded privately under `uploads`, scoped by endpoint and bucket, and verified against a signed upload marker and object ETag. Other bucket objects and uploads from other devices are excluded. Older uploads made before local history tracking cannot be automatically claimed. The gallery sorts all recorded images by upload time (newest/oldest) or filename (A–Z/Z–A) before pagination; newest first is the default. Filenames use the uploaded output filename rather than the generated object key.

Gallery cards and compression queue items mount their content only within 400 pixels of the viewport and unload it offscreen, keeping measured placeholders for scrolling. Keyboard focus can reveal a placeholder and prevents focused cards from unloading. Skeletons cover initial settings, R2 discovery, gallery pages and pagination, thumbnail reads, browser image decoding, compression previews, and full-resolution comparisons. Reduced-motion preferences disable skeleton animation; failures replace skeletons with the existing error or fallback UI.

Gallery thumbnails are generated on demand through authenticated S3 reads and stored locally in the app’s `gallery-thumbnails` directory. The cache persists across restarts, tracks object ETags (or modification time and size), and evicts older thumbnails above 128 MiB. Private buckets can show thumbnails without a public base URL. Full images load from the public URL only when you click a thumbnail or **View**. The first thumbnail generation may download an object up to 128 MiB; the temporary full image is removed afterward.

The public base URL must point to objects that are already publicly accessible. The app does not change bucket permissions or generate presigned URLs. Use HTTPS except for trusted local services.

Settings and secrets live in MyGo's user-data directory, separate from the old Tauri app. On macOS this is `~/Library/Application Support/Pic Piper/`. Credentials are plain local files, with private directory permissions and mode 0600 for secret files; they are not stored in Keychain or encrypted shared storage. Existing Tauri profiles are not imported. Optimizer cache runs older than seven days are cleaned up on a best-effort basis when creating a new run.

Settings opens **General** under **Application**. **Cloud storage** groups S3 profiles, **One-click authorization**, and links/naming. The authorization page currently offers Cloudflare R2, with provider-specific identity and browser sign-in inside the general category. Settings use consistent 14px field titles, 12px descriptions and 36px controls; preference selectors and switches stay on the right, while long text fields keep their labels above the inputs. The selected sidebar item has a white background in the light theme. General includes language, close-window behavior and the status-bar icon with its compression defaults. Closing the main window quits the app by default; you can independently choose **Close window and run in background**. Enabling the status icon locks that control to background operation and explains why. Disabling the icon restores your saved close-window preference. Explicit **Quit** still exits the app.

## Mini

First-run setup offers an optional **Mini** step, off by default. Enable it there or in **Settings → General → Status bar icon**. Its independent defaults are WebP at 90% quality and copying the compressed image content to the clipboard. Image clipboard content is decoded to PNG for compatibility with chat and document applications; the compressed cache file keeps the selected format. For a batch, the last successful image is copied automatically, and each result has its own copy action.

Click the status icon to open a fixed-size drop panel. Format and quality controls sit in the header. Only recent results scroll; the header, drop target, results heading, and retention footer stay in place. It stays open while you return to Finder to drag files. Close it with its close button, the status icon, or Escape; processing continues in Go, and reopening restores the queue. The top-right external-window button opens the full workbench. With Mini enabled, closing the main window hides it; use Quit from the app or status-icon menu to exit.

Each compressed result has separate **Copy image**, **Upload to S3**, and (after uploading) **Copy link** actions. Check individual rows or the select-all checkbox, then use **Upload** for the selection. Clicking an upload action opens the destination and link-format sheet; these controls are absent from the main panel and Mini preferences. Choose a saved S3 profile with a public base URL and plain URL, HTML, BBCode, or Markdown format, then confirm. Uploaded rows add a refresh mark to their cloud button. Each image remembers every uploaded bucket (endpoint + bucket, independent of profile aliases, prefixes, and naming); repeated destinations skip network writes and reuse their existing links. A selection can mix new uploads with existing links, and an entirely uploaded selection offers **Copy existing links**. Manual uploads use the existing compressed cache without another drop or compression and do not change the automatic completion action. Upload failures keep the image available for copying and retry. S3 uploads happen only after an explicit upload click. Legacy automatic-upload preferences are normalized to clipboard copying. Batch links are copied one per line. Drops capture compression defaults, while manual uploads capture the selected destination when clicked. Uploads retain conditional writes; conflicts receive one retry with a fresh suffix. Existing files and objects are never overwritten. Mini accepts up to 20 images per drop and bounds active compression work separately from its history. **Clear list** only hides Drawer records and offers Undo; it does not delete cached images or S3 gallery history. Completed and failed records automatically disappear 12 hours after processing finishes. Pending work continues when hidden. This temporary history and its bucket/link metadata survive closing the Drawer within the running app session; quitting the app ends that session.

macOS builds with cgo additionally accept Finder file URLs directly on the status icon through an AppKit status-window drag receiver. `pnpm test:tray` replays native window-level file drops and adapter cleanup; a physical Finder gesture remains a separate manual check. Other targets and cgo-disabled builds retain the panel's file-drop entry point. Linux packages declare the AppIndicator dependency; a compatible desktop panel or extension is still needed. Windows/Linux native interaction requires separate validation.

The App and template status icons are generated from the masters in `resources/logo-app.png` and `resources/logo-tray.png`. Run `node scripts/go.mjs run ./scripts/icon` to rebuild the packaged PNGs. After building, `pnpm test:app-icon` checks macOS IconServices' actual bundle rendering and saves a snapshot under `build/app-icon-check/`; it catches an extra white enclosure that raw PNG previews miss. The same check runs before packaged smoke. See [Mini and branding notes](docs/mini-and-branding.md) for architecture, generation prompts, and validation.

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

`pnpm smoke` launches the real packaged macOS app and drives its WebView and Go bridge. It uses private temporary app data, a disposable in-memory WebView session, synthetic images, fake credentials, and a loopback S3 fixture. Test language selections, cookies, and browser storage do not affect the normal app. Reports and screenshots are saved under `build/smoke-*`. It never contacts a production bucket. Mini validation writes synthetic image/text content to the clipboard. The smoke also switches all six languages through Settings and captures each settings page and the populated minimum-size workbench. Native OS file/folder dialogs and a physical Finder drag are still manual checks.

The S3 implementation uses the Go standard library with SigV4 signing. Local tests cover signing, conditional uploads, pagination, safe downloads, settings, and credentials; a live AWS/R2 account is not part of automated validation.

See [the compression workbench changes and validation](docs/image-workbench-polish.md) for the current experience and limitations. [The migration plan](docs/mygo-migration-plan.md), [framework research](docs/mygo-framework-research.md), and [MVP validation results](docs/mygo-mvp-results.md) record the earlier scope and measurements.
