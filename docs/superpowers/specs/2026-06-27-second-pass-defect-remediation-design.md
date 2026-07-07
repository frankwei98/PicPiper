# Pic Piper Second-Pass Defect Remediation Spec

## Goal

Fix the defects found after the first remediation wave. This pass focuses on remaining data-integrity risks, stale or misleading settings controls, avoidable S3 load, thumbnail correctness, and small correctness/UX gaps.

## Scope

Fix these confirmed issues:

1. Appending another same-named image after an earlier compression can overwrite the earlier output file because `importImages` clears `dispatchedOutputNames` while reusing `optimizerRun.current`.
2. Backend upload accepts arbitrary `object_key` even though generated keys are validated.
3. `SettingsPage` exposes `pathStyle` in the profile model but has no UI or setter.
4. `Allow local secret fallback` does not persist when changed without re-entering the secret.
5. `S3GalleryPage` lists S3 objects on every prefix keystroke.
6. Gallery download failures are not shown to users.
7. Gallery direct navigation does not use `defaultProfileId`; Optimize and Gallery can default to different profiles.
8. Gallery local HEIC upload falls back to `application/octet-stream`.
9. macOS thumbnail path encodes RGBA thumbnails as JPEG and loses alpha, unlike CPU fallback.
10. HTML drop and Tauri webview drag/drop may both import the same files.
11. S3 list pagination can loop forever if a provider returns `is_truncated=true` without a continuation token.
12. `history::append_history` is not safe under concurrent append calls.
13. `create_optimizer_run` can produce `run-0` if timestamp generation fails.
14. `remove_gps` is now dead API surface after the product decision that metadata is always stripped.
15. `formatBytes` reports very small files as `0 KB`.
16. `updateFormat` starts a new optimizer run but does not clear or rebuild dispatched filename claims, causing unnecessary `-2` suffixes.
17. Delete confirmation closes before the delete request completes, making failure context weak.
18. `uploadToS3` and `retryUploads` duplicate upload-loop logic.
19. `publicBaseUrl` accepts query/fragment strings that produce malformed public URLs.
20. Settings can edit existing profiles but still cannot add a second profile through the UI.

## Non-Goals

- Do not add auto-upload.
- Do not add a separate queue page.
- Do not add gallery rename/move.
- Do not add resize controls.
- Do not implement true EXIF preservation in this pass.
- Do not replace the AWS SDK or Tauri command architecture.

## Design

### Optimizer Output Integrity

Treat an optimizer run directory and its claimed output filenames as one unit. A new import batch may either reuse both safely or reset both. The simplest safe behavior is:

- If appending images to the existing list, keep `dispatchedOutputNames` claims from prior compressed items and active jobs.
- If clearing filename claims, also clear `optimizerRun.current` so new outputs go into a new run directory.
- `updateFormat` and global requeue should consistently reset both the run and claims, then let the scheduler rebuild claims from the items being recompressed.

Regression tests must cover appending two same-named files in two imports and changing format on one compressed item.

### S3 And Gallery Correctness

Backend upload must validate `request.object_key` before calling `put_object`. S3 list pagination must fail fast if the response is truncated and missing a continuation token.

Gallery prefix search should debounce list calls. A 300-500 ms debounce is enough. The displayed prefix can update immediately; the listed prefix should update after debounce.

Download should show a visible error on failure, just like delete and list errors.

Gallery should use the same default-profile resolution as Optimize. Pass `defaultProfileId` into `S3GalleryPage` or resolve a default `galleryFocus.profileId` in `App` when switching to Gallery.

HEIC local upload should use `image/heic` or `image/heif` instead of falling back to `application/octet-stream`.

`publicBaseUrl` should be validated in Settings. Reject values with query or fragment components. The accepted value is an origin/path base such as `https://cdn.example.com/images`, not a templated URL.

### Settings Profile Controls

Expose all profile fields that affect runtime behavior:

- Add a `Path style addressing` checkbox bound to `pathStyle`.
- Persist changes to `allowInsecureFallback` even when no new secret is entered.
- Add an `Add profile` button that clears the form for a new profile and generates a new profile id on save.

For existing profiles, preserving an old secret should not require re-entering it. For new profiles, a secret remains required.

### Thumbnails

The macOS ImageIO path should not silently lose alpha. Either detect alpha and encode PNG, or route alpha-capable formats through the CPU fallback. The lower-risk fix is to detect alpha after rendering and encode PNG when any alpha byte is not fully opaque.

### Drag And Drop

Use one authoritative import path for Tauri desktop drag/drop. Prefer `getCurrentWebview().onDragDropEvent`. The DOM drop handler can remain only as a non-Tauri/browser-test fallback if it is gated so it cannot process the same Tauri drop.

### History Concurrency

Serialize history appends inside the process. A simple app-managed `Mutex`/state wrapper around `append_history` is sufficient for this desktop app. Atomic writes protect crash consistency; the mutex protects read-modify-write lost updates.

### Minor API And UX Cleanup

- Replace `run-<timestamp_nanos>` with UUID-based run ids.
- Remove or stop exposing `remove_gps` where practical. If removing from Rust model is too invasive, keep the field but centralize the explanation that it is ignored because metadata is always stripped.
- Make `formatBytes` show bytes for values below 1000.
- Keep delete dialog open until the delete request succeeds, or show the object key in the failure message.
- Extract the shared upload loop for `uploadToS3` and `retryUploads`.

## Verification

Run:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test
PIC_PIPER_NO_KEYCHAIN=1 pnpm build
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo fmt --check
```

Targeted tests should be added for every listed behavior before implementation.
