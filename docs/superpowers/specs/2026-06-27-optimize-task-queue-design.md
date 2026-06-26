# Optimize Task Queue Design

Date: 2026-06-27

## Goal

Rework the image optimization page around automatic per-image compression tasks. Users should be able to drop or choose images, see each image progress independently, cancel or retry individual work, adjust global compression policy, choose output format per image, and compare original versus compressed previews.

## Scope

In scope:

- Remove preset support from the product during this development phase.
- Replace the optimize page preset controls with global `Remove GPS` and `Quality` controls.
- Start compression automatically after images are imported.
- Run independent single-image compression tasks through a bounded concurrency pool.
- Let each card choose its own output format.
- Show loading states, compressed previews, output sizes, cancel, retry, save, upload, and comparison modal behavior.

Out of scope for this iteration:

- True encoder percentage progress.
- Hard cancellation of an already-running Rust encoder task.
- Apple platform encoder acceleration.
- Cache cleanup for stale optimizer outputs.
- A broader UI component migration to shadcn.

## Preset Removal

Preset support will be removed completely because the app is still in development. The implementation should delete the TypeScript `CompressionPreset` type, Rust `CompressionPreset` model, `AppSettings.presets`, default preset creation, optimize page preset props and controls, settings page preset UI, and preset-specific tests.

Settings page copy should no longer mention presets. Settings should continue to cover S3 profiles, naming, and output-related configuration only.

## Compression Settings

The optimize page owns the active compression policy:

- `quality`: global number, default `85`.
- `removeGps`: global boolean, default `true`.
- `targetFormat`: per-image setting, derived from the inspected source format.

Per-image default target format:

- JPG defaults to JPG.
- PNG defaults to PNG.
- WebP defaults to WebP.
- AVIF defaults to AVIF.
- HEIC/HEIF defaults to WebP because built-in HEIF output is unavailable.
- Unknown formats default to WebP if inspect succeeds enough to enqueue the item.

The per-card format selector should not offer HEIF output. If PNG output is selected, the card can show a lightweight warning that quality does not affect PNG because the backend writes lossless PNG.

Changing the global quality or GPS option requeues all non-failed, non-cancelled items after a short debounce. Changing one card's format requeues only that item.

## Item Lifecycle

The UI item lifecycle is:

1. `inspecting`: file path is known and metadata is being read.
2. `queued`: metadata is available, but the item is waiting for an execution slot.
3. `compressing`: a single-image compression command is running.
4. `loadingPreview`: output exists and the app is reading a UI thumbnail from the compressed output path.
5. `compressed`: output path, output size, and compressed preview are ready.
6. `failed`: inspect, compression, or another required step failed.
7. `cancelled`: user cancelled the item.

`loadingPreview` only reads the compressed output file into a frontend-safe data URL via `readThumbnail`. It does not create another business output image.

Each item should carry a task version or equivalent request token. When global settings or the per-image format change, the item version increments. Late results from older versions must be ignored so stale compression output cannot overwrite the latest settings.

## Task Scheduling

The frontend should stop using the optimize page's current manual `Compress` button flow. Importing images starts work automatically.

Concurrency is bounded to:

```ts
Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1)
```

If `navigator.hardwareConcurrency` is unavailable, this effectively falls back to `3`. The scheduler starts up to this many `compressImage` Tauri commands at once. Remaining items stay in `queued` until a running item completes, fails, or is cancelled.

This avoids the current batch path's all-at-once behavior and gives each item independent completion, failure, cancellation, and retry behavior.

The backend's existing `compress_image` command remains the first-version execution primitive. The implementation plan can decide whether to keep `compress_batch` for internal tests or remove frontend usage only.

Single-image tasks still need deterministic output paths. The optimize page should create or request one cache output directory for the active queue session, then pass that directory to each `compressImage` call. Output filenames should be derived from the source filename and current target format, with duplicate names disambiguated before compression so two same-named inputs cannot overwrite each other.

## Cancellation

Cancellation is per item.

Queued items cancel immediately and should not be started by the scheduler. Inspecting items can be marked cancelled; when inspect returns, the result is discarded.

Running compression is soft-cancelled in this iteration. The UI should show that the item is cancelling or cancelled, but the underlying Tauri command may run until the Rust encoder returns. When it returns, the result is discarded if the item was cancelled or if its task version is stale.

Hard cancellation of encoder work requires a backend job registry, cancellable encoder integration, or process-level task isolation and is not part of this iteration.

Cancelled items are excluded from global quality or GPS-triggered requeues until the user explicitly retries them.

## Optimize Page UI

The top of the page removes:

- Preset select.
- `Apply preset`.
- Manual `Compress` button.

The replacement is a compact global control bar:

- `Remove GPS` checkbox.
- `Quality NN%` slider.

The queue remains the main surface. It should support the following states:

- `inspecting`, `queued`, `compressing`, `loadingPreview`: skeleton or loading preview area, status text, and cancel action.
- `compressed`: compressed thumbnail, output filename, original size to output size, savings ratio, format selector, and click-to-compare behavior.
- `failed`: error message, format selector if inspection data exists, retry, and remove.
- `cancelled`: cancelled status, retry, and remove.

Save and upload actions remain on the optimize page and operate only on compressed items. There is no separate results mode; import, automatic compression, preview, compare, save, and upload happen in one queue view.

## Comparison Modal

Clicking a compressed card's preview opens a modal using the existing `Dialog` component. The modal shows:

- Original image preview on the left.
- Compressed image preview on the right.
- File name.
- Original size.
- Output size.
- Quality.
- Remove GPS state.
- Output format.

Both previews use frontend-safe data URLs produced by `readThumbnail`. On narrow screens, the two columns stack vertically.

If the compressed output exists but a thumbnail fails to load, the item can still be saved or uploaded. The modal should show a placeholder or error in the affected preview area instead of treating thumbnail failure as compression failure.

## Error Handling

Errors are item-local.

An inspect failure marks only that item as failed. A compression failure marks only that item as failed and keeps inspected metadata so the user can change format and retry. A thumbnail failure should not block save or upload.

Retry requeues the selected item using the latest global quality, latest GPS option, and that item's current target format.

Upload and save should continue to operate on available compressed items. Upload failures remain per item, matching the existing upload behavior.

## Performance Notes

The first implementation keeps the current Rust encoding path based on `image`, `webp`, and AVIF support. The app already has a macOS ImageIO/CoreGraphics path for thumbnails. Apple platform encoder acceleration should be evaluated later as a separate performance project because format support, quality semantics, metadata behavior, and output consistency differ across system APIs.

The queue scheduler prevents unbounded frontend-triggered Tauri compression calls. Stale output cleanup can be added later once the cache layout and retention policy are explicit.

## Testing

Frontend tests should cover:

- Optimize page no longer renders preset controls or a manual `Compress` button.
- Importing images starts inspect and compression automatically.
- The scheduler starts only up to the computed concurrency limit.
- Quality changes debounce and requeue existing non-failed, non-cancelled items with the new quality.
- Remove GPS changes requeue existing non-failed, non-cancelled items.
- Format selector defaults to source format, except HEIC/HEIF default to WebP.
- Changing one card's format requeues only that item.
- Cancelled items do not update from late task results.
- Compression completion reads the compressed output thumbnail.
- Clicking a compressed preview opens the comparison modal.
- Failed, cancelled, and retry states remain item-local.

Rust tests should cover:

- `AppSettings::default()` no longer includes presets.
- Settings load/save tests use the new schema.
- Existing optimizer tests continue to cover format behavior, quality effects, HEIF output failure, and output file naming as long as the related backend APIs remain.

Before handoff, run:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test
PIC_PIPER_NO_KEYCHAIN=1 pnpm build
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo fmt --check
```
