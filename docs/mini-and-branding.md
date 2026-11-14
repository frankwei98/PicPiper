# Mini and the Pic Piper icon

Implementation dates: 2026-11-13 through 2026-11-14. User-authorized branch: `feat/i18n-foundation`. No branch switch, fetch, commit, or push was performed.

## Resulting behavior

- OOBE always offers Mini after the selected feature/storage steps. Mini starts disabled and expands the compression fields only when enabled. Settings has the same controls. There is no redundant skip button.
- The compact tray panel follows the approved design: open-full-window and close in its top-right corner, a fixed drop field, format/quality in the header instead of a MINI badge, selectable result rows with an indeterminate select-all checkbox, selection-based Upload, Clear list with Undo, and a twelve-hour retention footer. Upload destinations and four link-format choices appear only in the upload sheet. An uploaded row adds a refresh mark to its cloud icon. Its 362 × 560 viewport has no document scrollbar; only the recent-results body scrolls, with its heading kept fixed. It stays visible when focus moves to Finder; explicit close, tray toggle, and Escape dismiss it.
- Go owns a bounded serial queue; the existing imaging service bounds codec work and keeps compression outputs in the private optimizer cache. Dismissing the WebView does not cancel work. Drops always compress and copy image content. The old automatic-upload option is removed from OOBE and Settings, and legacy upload preferences normalize to clipboard copying on load/save. Drops capture their compression preferences. Manual uploads capture the destination and naming settings when clicked and reuse the existing compressed output without creating another optimizer run. Each result retains every successful bucket upload. Bucket identity uses normalized endpoint + bucket, excluding profile identity, credentials, naming templates, prefixes and public URL settings. Switching buckets and later switching back reuses the original link without another PUT; aliases of the same bucket also skip. Mixed selections upload only new objects, then copy new and existing links together.
- The image clipboard receives PNG decoded from the selected compressed result, preserving its decoded transparency and dimensions. Compression/export format remains the selected WebP/JPEG/PNG/AVIF format. A batch copies the last successful image; other results remain individually copyable. Image and link copying are separate actions, so uploaded images can still be pasted as images. Upload failures preserve successful compression and expose a retryable per-result upload error.
- S3 uses saved local credentials and existing signing/upload-record infrastructure. A public base URL is required because Mini copies shareable links rather than presigned credentials. Conditional writes protect existing objects, with one fresh-suffix retry on conflict. Multiple links are joined with newlines.
- macOS Finder icon drops use a small cgo/AppKit adapter. It finds this process's matching `NSStatusBarButton`, then registers its status-item window for file URLs and installs a drag receiver as the window delegate, following [AppKit's documented window drag forwarding](https://developer.apple.com/documentation/appkit/nswindow/registerfordraggedtypes%28_%3A%29?language=objc). Existing delegate callbacks are forwarded, and disabling Mini detaches the receiver before destroying the tray. Matching prefers the current visible status window so re-enabling Mini cannot attach to a retired hidden window that awaits autorelease. The button and MyGo's appearance observer stay intact. Other systems and cgo-disabled builds retain panel drops. Linux package dependencies include AppIndicator.

## Code boundaries

- `internal/mini`: serial background queue, separate active-work bounds and twelve-hour result history, hide/undo, immutable snapshots, per-bucket upload history, clipboard conversion, safe link formatting.
- `internal/cloud/mini.go`: persistent defaults, validation, destination snapshots and bucket identity, public upload-sheet targets, upload integration.
- `internal/traydrop`: native status-window file-drop adapter and portable fallback.
- `desktop.go`: main-thread-only tray and flyout lifecycle; `main.go` routes bridge operations.
- `src/features/mini`: selection panel, upload sheet and compression dialog, compression-only shared preferences, six-language UI and behavior tests. `src/mygo.ts` is regenerated.

Settings remain private local files; credentials remain in their existing restricted credential files. Mini adds no credential storage or logs, bucket permission changes, or real-provider test traffic.

## Branding assets

Generated with the built-in `image_gen` tool. The App mark is a geometric piper bird whose wing contains a folded-image motif. The status icon is its matching black template silhouette with alpha transparency.

- `resources/logo-app.png`: generated App master.
- `resources/logo-tray.png`: generated transparent template master.
- `resources/icon.png`: 1024² App icon, used by MyGo packaging for platform icons.
- `resources/logo-ui.png`: 96² UI derivative, avoiding a large App icon download in each WebView.
- `resources/tray.png`, `resources/tray@2x.png`: 32² / 64² black template PNGs. The native tray embeds the 64² version.

`scripts/icon` preserves the generated masters, sizes derivatives with Catmull–Rom filtering, centers the status mark by its alpha bounds, and retains alpha while making visible RGB black. Master files are excluded from the distributable.

### Final generation prompts

App icon:

> Use case: logo-brand. Asset type: production desktop app icon for Pic Piper, a fast image compression and sharing utility. Create ONE final icon, no presentation sheet or mockup. Design a distinctive bold geometric piper bird mark, subtly suggesting a folded photograph in the wing and the letter P through negative space. Bird faces right. Friendly, precise, minimal, no thin outlines or tiny detail. White bird silhouette on a vivid cobalt blue (#0052ff) rounded-square macOS icon tile; restrained soft dimensional depth, mostly flat vector-like finish. Composition: centered single symbol, optically balanced, icon tile fills about 86% of a square canvas with transparent outside corners and even margins. Must remain recognizable at 16px and work later as a monochrome menu-bar silhouette. No letters, no words, no watermark, no extra objects, no drop shadow extending outside the tile. Clean professional desktop utility identity, not a generic clipart bird.

Matching template edit:

> Use case: logo-brand. Edit the preceding Pic Piper app icon into its matching production macOS menu-bar template mark. Keep the exact same bird pose, head, beak, tail, proportions, and photograph-shaped negative-space wing. Remove the blue rounded-square tile entirely. The ONLY visible pixels must be the bird rendered in solid pure black with smooth alpha edges, all former blue areas including its eye and wing are fully transparent. Remove the fold's gray shading; make that part a crisp transparent notch if necessary, keeping the silhouette simple and coherent. Center the bird with about 8 percent even padding on a genuinely transparent square canvas. No tile, no shadow, no color, no gray, no words. Strong readable silhouette for 18pt menu-bar rendering.

## Validation scope

Go behavior regressions cover twelve-hour expiry at the exact boundary, hidden pending work continuing, Undo refusing expired records, cached files staying intact, immutable upload/link snapshots, forty-result histories and selections beyond the compression queue limit, per-bucket history across A → B → A, profile aliases with different prefixes/public URLs, zero PUTs for repeated buckets, no gallery deletion on Clear, and image-copy defaults. Existing orientation, transparency, safe cache/output paths, signing, conditional writes, conflicts, credentials, and naming regressions remain in the full suite.

Feature UI tests cover the compact header, compression-only OOBE/Settings fields, no upload controls before opening the sheet, individual/indeterminate/select-all selection, confirm-before-upload, all-existing versus mixed upload counts, four link formats, no configured destination, Clear/Undo, independent image/link copying and restoring the running queue after panel remount. Temporary Drawer history belongs to the running Go service; closing the panel preserves it, while quitting the app ends that session. S3 gallery history keeps its existing persistence.

The packaged smoke uses private data, synthetic images, fake credentials and a loopback bucket. It first runs `pnpm test:tray`'s native replay through a real AppKit status-item window: file-URL delivery, remote-URL rejection, previous delegate forwarding, detach/re-enable and tray recreation. This regression catches the earlier button-only adapter's failure to receive window-level drag messages. It then counts successful writes and PUT attempts, verifies image copy before any upload, uploads with the panel closed, reopens, copies all four formats without another PUT, uploads ten new objects while skipping one existing selection, retains all eleven links, confirms Clear/Undo leaves gallery objects intact, checks all six languages in the fixed viewport, and verifies independent scrolling. Physical Finder gestures, native OS pickers, Windows/Linux native operation and real provider credentials remain separate manual checks.

Mini workflow validation on macOS arm64 before the status-icon drop correction:

- `pnpm test`: 27 files, 229 tests passed.
- `pnpm build:web`, `pnpm test:go`, `node scripts/go.mjs test -race ./...`, `node scripts/go.mjs vet ./...`: passed.
- `node scripts/go.mjs test -race ./internal/imaging -run '^TestModernCodecsConcurrentFirstUse$' -count=1`: passed.
- Required `gofmt` check and `git diff --check`: clean.
- The conditional-upload conflict test passed 20 repetitions after replacing base64url suffixes with hex.
- `pnpm build`: passed. The full native report `build/smoke-JMPcGn/report.json` passed selection, mixed uploads, bucket skipping, native clipboard, Clear/Undo, all six Mini languages and the later app URL restore/focus check. Inspected `mini-selection-zh-CN.png`, `mini-upload-mixed-zh-CN.png`, and `mini-cleared.png`. Clipboard/Clear/Undo notifications also switch with the active language.
- Geometry: document and scroll dimensions are both 362 × 560; the independent results area is 319 px high with 716 px of content. Header, drop field, results heading and retention footer stayed fixed.
- The native driver waits for WebView readiness after reopening and for all row checkboxes to become ready before select-all. Queued RPC replies can precede clipboard completion; the driver waits for clipboard sequence changes and enabled controls before the next action.
- `pnpm test:go`, full `test -race`, isolated modern-codec concurrent-first-use test, `vet`, `gofmt`, and `git diff --check`: passed.

Status-icon drop correction validation, 2026-11-14:

- `pnpm test:tray` failed with the button-only adapter and passed with the status-window receiver. It also covers cleanup, re-enabling and status-item recreation without binding a retired hidden window.
- Frontend tests (229), web build, Go tests, full race checks, isolated codec first-use check, vet, formatting and native packaging passed.
- `build/smoke-qhuGyH/report.json` passed the Mini checks; the full run failed at the later app URL restore/focus check (`received=false`) while a normal app instance was also running. Inspected the Mini selection and upload-sheet screenshots and scroll geometry.
- Manual Finder validation: the user quit the old app, opened the rebuilt app, dragged a local image onto its status icon and confirmed that compression started. This confirms the physical Finder entry point in addition to the native replay; it does not extend validation to other drag sources or operating systems.

Commands used `GOCACHE=/private/tmp/pic-piper-go-build-cache` because the host's default Go cache is outside the writable sandbox. Go/S3 tests and native packaging/smoke ran with approved access for loopback listeners and macOS UI integration. No real provider was contacted. The native smoke waits for the minimize notification before testing URL restoration. Normal app instances can receive the OS protocol request instead of a separately launched smoke instance; the recorded full validation passed with the test instance.
