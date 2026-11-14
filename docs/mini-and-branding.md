# Mini and the Pic Piper icon

Implementation dates: 2026-11-13 through 2026-11-14. User-authorized branch: `feat/i18n-foundation`.

## Resulting behavior

- OOBE always offers Mini after the selected feature/storage steps. Mini starts disabled and expands the compression fields only when enabled. Settings has the same controls. There is no redundant skip button.
- Settings groups General under Application, with S3 profiles, One-click authorization and links/naming under Cloud storage. Cloudflare R2 is the current provider inside the general authorization category. Mini preferences live in General, alongside language and close-window behavior. Shared preference rows keep selects and switches on the right, with 14px foreground field titles, 12px descriptions and 36px inputs. The light-theme selected item is white with a border and subtle shadow. Base UI Tabs supplies keyboard navigation across the groups.
- The persisted close-window preference defaults to quitting and can independently keep the main window hidden while the app runs. A live status icon overrides this to background operation; General shows a disabled background selection with an explanation. The user's underlying preference is retained and restored when the icon is disabled. Explicit Quit follows the normal shutdown lifecycle in either mode.
- The compact tray panel follows the approved design: open-full-window and close in its top-right corner, a fixed drop field, format/quality in the header instead of a MINI badge, selectable result rows with an indeterminate select-all checkbox, selection-based Upload, Clear list with Undo, and a twelve-hour retention footer. Upload destinations and four link-format choices appear only in the upload sheet. An uploaded row adds a refresh mark to its cloud icon. Its 362 × 560 viewport has no document scrollbar; only the recent-results body scrolls, with its heading kept fixed. It stays visible when focus moves to Finder; explicit close, tray toggle, and Escape dismiss it.
- Go owns a bounded serial queue; the existing imaging service bounds codec work and keeps compression outputs in the private optimizer cache. Dismissing the WebView does not cancel work. Drops always compress and copy image content. The old automatic-upload option is removed from OOBE and Settings, and legacy upload preferences normalize to clipboard copying on load/save. Drops capture their compression preferences. Manual uploads capture the destination and naming settings when clicked and reuse the existing compressed output without creating another optimizer run. Each result retains every successful bucket upload. Bucket identity uses normalized endpoint + bucket, excluding profile identity, credentials, naming templates, prefixes and public URL settings. Switching buckets and later switching back reuses the original link without another PUT; aliases of the same bucket also skip. Mixed selections upload only new objects, then copy new and existing links together.
- The image clipboard receives PNG decoded from the selected compressed result, preserving its decoded transparency and dimensions. Compression/export format remains the selected WebP/JPEG/PNG/AVIF format. A batch copies the last successful image; other results remain individually copyable. Image and link copying are separate actions, so uploaded images can still be pasted as images. Upload failures preserve successful compression and expose a retryable per-result upload error.
- S3 uses saved local credentials and existing signing/upload-record infrastructure. A public base URL is required because Mini copies shareable links rather than presigned credentials. Conditional writes protect existing objects, with one fresh-suffix retry on conflict. Multiple links are joined with newlines.
- macOS Finder icon drops use a small cgo/AppKit adapter. It finds this process's matching `NSStatusBarButton`, then registers its status-item window for file URLs and installs a drag receiver as the window delegate, following [AppKit's documented window drag forwarding](https://developer.apple.com/documentation/appkit/nswindow/registerfordraggedtypes%28_%3A%29?language=objc). Existing delegate callbacks are forwarded, and disabling Mini detaches the receiver before destroying the tray. Matching prefers the current visible status window so re-enabling Mini cannot attach to a retired hidden window that awaits autorelease. The button and MyGo's appearance observer stay intact. Other systems and cgo-disabled builds retain panel drops. Linux package dependencies include AppIndicator.

## Code boundaries

- `internal/mini`: serial background queue, separate active-work bounds and twelve-hour result history, hide/undo, immutable snapshots, per-bucket upload history, clipboard conversion, safe link formatting.
- `internal/cloud/mini.go`: persistent defaults, validation, destination snapshots and bucket identity, public upload-sheet targets, upload integration.
- `internal/cloud/desktop.go`: native preference snapshot and close-behavior defaults. Preferences use the existing private settings file and atomic persistence.
- `internal/traydrop`: native status-window file-drop adapter and portable fallback.
- `desktop.go`: main-thread-only tray and flyout lifecycle; `main.go` routes bridge operations.
- `src/features/mini`: selection panel, upload sheet and compression dialog, compression-only shared preferences, six-language UI and behavior tests. `src/mygo.ts` is regenerated.

Settings remain private local files; credentials remain in their existing restricted credential files. Mini adds no credential storage or logs, bucket permission changes, or real-provider test traffic.

## Branding assets

The current mark is the user-supplied crocodile compressing a large image into a smaller image. Its source (`卡通鳄鱼压缩图片图标.png`, 1254²) had no alpha channel. The built-in `image_gen` tool removed the black canvas outside the dark rounded-square tile while retaining the color artwork and dark tile. App/Dock icons, Mini and onboarding use this same color version in both light and dark themes. A separately simplified crocodile head supplies the monochrome macOS status-bar template. The main window's title-bar brand reuses that template as an alpha mask, colored with the theme foreground: black in light mode and white in dark mode, without a tile.

- `resources/logo-app.png`: 1254² transparent App master edited from the supplied image.
- `resources/logo-tray.png`: generated transparent template master.
- `resources/icon.png`: 1024² App icon, used by MyGo packaging for platform icons.
- `resources/logo-ui.png`: 96² UI derivative, avoiding a large App icon download in each WebView.
- `resources/tray.png`, `resources/tray@2x.png`: 32² / 64² black template PNGs. The native tray embeds the 64² version.

`scripts/icon` preserves the generated masters, sizes derivatives with Catmull–Rom filtering, centers the status mark by its alpha bounds, and retains alpha while making visible RGB black. Master files are excluded from the distributable.

App/UI derivatives promote near-opaque alpha values (245–254) to 255 while preserving RGB, transparent corners and partially transparent edge pixels. The original cutout left most of the dark tile just below full opacity; macOS IconServices classified that artwork as foreground and wrapped it in an additional white enclosure. Making only those near-opaque pixels solid removed the enclosure in a controlled native comparison. The status template's alpha is not normalized this way.

### Final generation prompts

App icon:

> Use case: background-extraction. Asset type: production macOS desktop app icon. Edit target: the attached local crocodile image. Primary request: remove ONLY the opaque black canvas outside the large dark rounded-square icon tile, replacing that outside area with genuine alpha transparency. KEEP the existing near-black rounded-square tile itself and all artwork inside it. Preserve the green smiling crocodile, closed eye, nostrils, pink cheek, cream teeth, purple large photo, two chevrons, smaller photo, feet, exact composition and relative positions. The dark icon tile must keep its original rounded corner shape, original even canvas margins and original dark color. This is a careful cutout, not a redesign. Preserve the source's visual identity and interior details as faithfully as possible. No new objects, no text, no watermark, no outer drop shadow. Output one square production icon with actual transparent outside corners.

Matching template edit:

> Use case: logo-brand. Asset type: matching macOS menu-bar template icon, black silhouette with genuine transparent background. Edit target/reference: the provided green smiling crocodile app icon. Derive ONE simplified matching template mark from this exact crocodile character. Show just its recognizable right-facing head and open jaw, with its long rounded snout, two nostril cutouts, curved smiling closed eye and broad teeth. Include a single simple photo rectangle held inside the open mouth as a transparent negative-space outline if readable. Remove the dark square tile, body, feet, cheek blush, chevrons and second small photo. Preserve the source crocodile's friendliness, shape language and snout/jaw proportions; do not introduce another animal or generic logo. All visible pixels must be solid pure black with smooth alpha edges. All interior eye, nostril and mouth/photo holes must be genuinely transparent. Use few broad shapes and spacious negative spaces that remain clear at 18pt; omit tiny details and shading. Center the mark with approximately 10 percent transparent padding. One square transparent PNG mark only, no tiles, no presentation sheet, no text, no shadow, no gray or color.

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

Grouped settings and close-window behavior validation, 2026-11-14:

- Frontend: 28 files / 235 tests passed, including cross-group keyboard navigation, the effective background lock, preference restoration and general-settings persistence. The six translation catalogs passed key/interpolation parity checks.
- Go tests, full race checks, isolated codec first-use race check, vet, formatting, web build and native packaging passed. Cloud regressions cover legacy settings, both saved close preferences surviving icon changes, and invalid values preserving existing settings.
- Full packaged smoke passed: `build/smoke-MbDVZ8/report.json`. Real native close events hid and reopened the window with an independent background preference and with the icon override. With the icon off and the default preference, closing the main window requested application quit; a temporary listener observed and canceled that request so the suite could finish.
- Inspected `settings-zh-CN.png` and `settings-fr.png`: grouped navigation, white selected row, merged status-icon controls and disabled close selector with explanation render correctly. All six languages passed the native sidebar bounds check. The full run also passed Mini, S3, clipboard and app URL restoration checks.

Crocodile icon replacement validation, 2026-11-14:

- App and UI PNGs retain alpha outside the tile; the 32² and 64² status icons contain black RGB with alpha. App and UI derivatives are 1024² and 96² respectively.
- All 235 frontend tests, Go tests, full race checks, the isolated modern-codec first-use check, vet, formatting, web build and native packaging passed.
- Full packaged smoke passed: `build/smoke-J6rTjW/report.json`. Inspected `light-theme.png`, `dark-theme.png` and `mini-selection-zh-CN.png`; both themes and Mini use the same color black-tile crocodile logo.
- The settings visual-system audit and proposed row/typography changes are recorded in [settings-visual-system.md](settings-visual-system.md) as a review draft. This icon change does not apply that proposed settings redesign.

System white-enclosure correction, 2026-11-14:

- Reproduced the user's Dock appearance through `NSWorkspace.iconForFile` on the actual built bundle. The original dark tile was nested inside a white system tile; the native check failed at pixel `(256,56)` with RGB `0.925 / 0.922 / 0.922`.
- A controlled copy with only near-opaque ICNS alpha made fully opaque rendered without the enclosure. The production icon generator now performs that normalization on App/UI derivatives. Its Go regression retains transparent corners and antialiased edges while keeping tile RGB unchanged.
- `pnpm test:app-icon` failed before the correction and passed on the rebuilt app. The original reproduction also passed on the same app path, with dark RGB `0.114 / 0.110 / 0.153` at the sampled pixel. This verifies the OS-rendered icon rather than only a raw image preview.
- The native check now runs inside `pnpm smoke`. Both `build/smoke-MthEwr/app-icon-report.json` and `report.json` passed. Inspected `system-app-icon.png` and the Mini screenshot. Frontend tests (235), Go tests, full race checks, isolated codec first use, vet, formatting, web build and native packaging passed.

Main title-bar monochrome mark, 2026-11-14:

- Only `.masthead .brand-mark` uses the existing transparent status mark as a CSS mask. Theme foreground colors it black in light mode and white in dark mode. App/Dock icons, Mini and onboarding keep their color assets.
- Frontend tests (235), Go/race/codec checks, vet, formatting, web build and packaging passed. Inspected `build/smoke-r1RC2M/light-theme.png` and `dark-theme.png`; both show the intended single-color head without a tile. The native app-icon check also passed.
- This smoke run completed the image, S3, Mini and close-window checks but failed at the later app URL restore/focus check (`received=false`). The full report remains marked failed rather than treating the successful logo screenshots as a full-suite pass.

Settings visual-system implementation and generic authorization category, 2026-11-14:

- Applied the approved settings design through shared preference rows and 14px/12px/36px tokens. Selects and switches remain on the right; General rows share 20px vertical padding and separators. Long text fields use the same typography/control geometry with labels above the input.
- Renamed the navigation, page heading and S3 entry point to One-click authorization. Cloudflare R2 is identified inside its provider section; the browser flow, credential storage and cancellation behavior remain unchanged. All six catalogs include the new category and preference labels.
- Frontend: 28 files / 237 tests passed. Web/macOS builds, Go tests, full race checks, isolated codec first use, vet, formatting and `git diff --check` passed.
- Full packaged smoke and the native app-icon check passed: `build/smoke-X7xxJG/report.json` and `app-icon-report.json`. Inspected Chinese General, French minimum-size settings and the S3 form. Native geometry checks cover right alignment, row padding, 14px titles, 12px descriptions, 36px controls and horizontal bounds in all six languages. Close-window behavior, Mini, S3, clipboard and app URL restoration passed too.
- The reviewed design and implementation details are recorded in [settings-visual-system.md](settings-visual-system.md).

Wide-window settings alignment correction, 2026-11-14:

- Removed `.settings-content`'s 850px maximum width. Preference controls and Save now share the viewport's right content inset when the window expands.
- The native regression measures actual visible control edges against that inset. It failed before the correction (`build/smoke-fOtel4/report.json`) and passed after it in the full smoke report `build/smoke-W44sea/report.json`. Inspected English and Chinese at 1920px; Chinese at 1120px and all six languages at minimum size passed too.
- Frontend tests (237), web/macOS builds, Go tests, full race checks, isolated codec first use, vet, formatting and `git diff --check` passed. The packaged icon, Mini, S3, clipboard, native close behavior and URL restoration checks also passed.

Commands used `GOCACHE=/private/tmp/pic-piper-go-build-cache` because the host's default Go cache is outside the writable sandbox. Go/S3 tests and native packaging/smoke ran with approved access for loopback listeners and macOS UI integration. No real provider was contacted. The native smoke waits for the minimize notification before testing URL restoration. Normal app instances can receive the OS protocol request instead of a separately launched smoke instance; the recorded full validation passed with the test instance.
