# Pic Piper Second-Pass Defect Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix remaining verified defects after the first remediation wave without changing Pic Piper's approved product scope.

**Architecture:** Start with high-risk output and S3 validation fixes, then repair settings/profile behavior, gallery request behavior, thumbnail correctness, and minor cleanup. Each task adds regression tests first and runs targeted verification before a scoped commit.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Tauri 2, Rust, AWS SDK for Rust, macOS ImageIO/CoreGraphics.

---

## Working Rules

- Repository root: `/Users/frankwei/Code/DesktopApp/pic-piper`
- Do not revert unrelated dirty files.
- Use `PIC_PIPER_NO_KEYCHAIN=1` for all test/build commands listed here.
- Preserve product non-goals: no auto-upload, no standalone queue page, no gallery rename/move, no resize controls.
- Commit each task separately when tests pass.

## Task 1: Prevent Appended Import Output Overwrites

**Files:**
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify: `src/features/optimize/OptimizePage.test.tsx`
- Modify: `src/features/optimize/optimizeQueue.ts` only if helper extraction is needed.

**Steps:**
- [ ] Add a failing frontend test: import `photo.jpg`, wait for compression to `photo.webp`, import another `photo.jpg`, and assert the second `compressImage` call uses either a new run directory or `photo-2.webp`.
- [ ] Remove the unsafe `dispatchedOutputNames.current.clear()` from `importImages`, or pair it with `optimizerRun.current = null`.
- [ ] Ensure claims are rebuilt or retained so existing compressed items and active tasks keep unique output names.
- [ ] Add a test for `updateFormat`: changing one compressed item format should not produce an unnecessary stale `-2` suffix in a new run.
- [ ] In `updateFormat`, reset filename claims consistently with the new optimizer run, or rebuild claims from the active recompression set.
- [ ] Run `PIC_PIPER_NO_KEYCHAIN=1 pnpm test -- src/features/optimize/OptimizePage.test.tsx src/features/optimize/optimizeQueue.test.ts`.
- [ ] Commit: `fix: prevent appended optimize outputs from overwriting`.

## Task 2: Validate Upload Object Keys And S3 Pagination Tokens

**Files:**
- Modify: `src-tauri/src/gallery.rs`
- Modify: `src-tauri/src/lib.rs` if validation is placed at command boundary.
- Test: `src-tauri/src/gallery.rs` or `src-tauri/src/naming.rs`

**Steps:**
- [ ] Add a Rust test proving upload rejects invalid object keys such as `../evil.webp`, `/evil.webp`, and `a//b.webp`. If direct AWS upload is hard to test, extract and test a `validate_upload_request` helper.
- [ ] Call `naming::validate_object_key(&request.object_key)` before `put_object`.
- [ ] Add a pagination helper test for `is_truncated=true` with no next continuation token.
- [ ] Change list pagination to return an `s3PaginationFailed` error when truncated response has no next token.
- [ ] Run `cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test gallery naming`.
- [ ] Commit: `fix: validate uploaded object keys and pagination`.

## Task 3: Repair Settings Profile Controls

**Files:**
- Modify: `src/features/settings/SettingsPage.tsx`
- Modify: `src/features/settings/SettingsPage.test.tsx`
- Modify: `src/api/tauri.ts` only if type changes are needed.

**Steps:**
- [ ] Add a failing test that toggles `Allow local secret fallback` on an existing profile without entering a new secret and expects saved profile `insecureSecretFallback` to match the checkbox.
- [ ] Change the no-new-secret branch to use current `allowInsecureFallback` for the saved profile, while preserving `credentialRef`.
- [ ] Add a `Path style addressing` checkbox with `pathStyle` state and setter.
- [ ] Add tests proving path style can be toggled and saved.
- [ ] Add an `Add profile` button that clears the form, clears `editingProfileId`, and lets save create a new UUID-backed profile.
- [ ] Add a test for adding a second profile without overwriting the first.
- [ ] Run `PIC_PIPER_NO_KEYCHAIN=1 pnpm test -- src/features/settings/SettingsPage.test.tsx`.
- [ ] Commit: `fix: complete profile settings controls`.

## Task 4: Debounce Gallery Prefix And Align Default Profile

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/features/gallery/S3GalleryPage.tsx`
- Modify: `src/features/gallery/S3GalleryPage.test.tsx`
- Modify: `src/state/appState.ts` only if needed.

**Steps:**
- [ ] Add a test proving direct Gallery navigation uses `settings.defaultProfileId` instead of always `profiles[0]`.
- [ ] Pass `defaultProfileId` to `S3GalleryPage`, or set `galleryFocus.profileId` when switching to Gallery.
- [ ] Add a test using fake timers: type multiple prefix characters and assert only one `listObjects` call after debounce.
- [ ] Implement a debounced list prefix, such as `debouncedPrefix`, updated 300-500 ms after `prefix`.
- [ ] Keep the input value immediate while `listObjects` uses the debounced value.
- [ ] Run `PIC_PIPER_NO_KEYCHAIN=1 pnpm test -- src/App.test.tsx src/features/gallery/S3GalleryPage.test.tsx`.
- [ ] Commit: `fix: debounce gallery prefix and default profile`.

## Task 5: Surface Gallery Download Errors And Improve Delete Failure Context

**Files:**
- Modify: `src/features/gallery/S3GalleryPage.tsx`
- Modify: `src/features/gallery/S3GalleryPage.test.tsx`

**Steps:**
- [ ] Add a test where `galleryApi.downloadObject` rejects and a visible error message is rendered.
- [ ] Add `downloadError` state or reuse a typed status state with `variant="error"`.
- [ ] Catch download errors and render them.
- [ ] Add a test where delete fails and the failed object key is included in the error text.
- [ ] Keep the delete dialog open until deletion succeeds, or set an error like `Failed to delete <key>: <message>`.
- [ ] Run `PIC_PIPER_NO_KEYCHAIN=1 pnpm test -- src/features/gallery/S3GalleryPage.test.tsx`.
- [ ] Commit: `fix: show gallery operation failures`.

## Task 6: Fix Gallery Local Upload Content Types And Public Base URL Validation

**Files:**
- Modify: `src/features/gallery/S3GalleryPage.tsx`
- Modify: `src/features/gallery/S3GalleryPage.test.tsx`
- Modify: `src/features/settings/SettingsPage.tsx`
- Modify: `src/features/settings/SettingsPage.test.tsx`

**Steps:**
- [ ] Add a Gallery test uploading `.heic` and expect `contentType: "image/heic"` or `"image/heif"`.
- [ ] Add `heic` to the content type map.
- [ ] Add Settings tests rejecting Public Base URL values with `?` or `#`.
- [ ] Implement validation before save: parse with `new URL(publicBaseUrl)` when non-empty and reject query or fragment.
- [ ] Keep existing valid URL behavior unchanged.
- [ ] Run gallery and settings tests.
- [ ] Commit: `fix: validate public base url and heic uploads`.

## Task 7: Avoid Duplicate Drag/Drop Imports

**Files:**
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify: `src/features/optimize/OptimizePage.test.tsx`

**Steps:**
- [ ] Add a test or refactor-level guard proving the same path list is not imported twice when both DOM drop and Tauri drop happen close together.
- [ ] Prefer Tauri `getCurrentWebview().onDragDropEvent` as the real desktop path.
- [ ] Either remove the DOM `onDrop` handler or gate it as a fallback only when Tauri drag/drop registration fails.
- [ ] Preserve tests for browser-style fallback if kept.
- [ ] Run optimize tests.
- [ ] Commit: `fix: avoid duplicate drag drop imports`.

## Task 8: Preserve Alpha In macOS Thumbnails

**Files:**
- Modify: `src-tauri/src/thumbnail.rs`

**Steps:**
- [ ] Add a Rust unit test around a helper that encodes RGBA thumbnail bytes with alpha as PNG and opaque data as JPEG.
- [ ] Extract encoding from `read_thumbnail_macos` into a helper such as `encode_thumbnail_data_url(width, height, rgba)`.
- [ ] If any alpha byte is less than 255, encode PNG and return `data:image/png;base64,...`.
- [ ] If fully opaque, keep JPEG behavior.
- [ ] Run `cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test thumbnail`.
- [ ] Commit: `fix: preserve alpha in macos thumbnails`.

## Task 9: Serialize Upload History Appends

**Files:**
- Modify: `src-tauri/src/history.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/state.rs` if app state stores the lock.

**Steps:**
- [ ] Add a Rust test or helper test showing two append operations cannot interleave read-modify-write without serialization.
- [ ] Add a `Mutex` around history appends in app-managed state, or expose a `HistoryStore` wrapper with a mutex.
- [ ] Update `upload_gallery_object` to append through the locked path.
- [ ] Keep atomic temp-file writes.
- [ ] Run `cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test history`.
- [ ] Commit: `fix: serialize upload history appends`.

## Task 10: Run ID And Metadata API Cleanup

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src/types.ts`
- Modify: `src/api/tauri.ts`
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify tests as needed.

**Steps:**
- [ ] Add `uuid` dependency in Rust or use an existing random-id source if available.
- [ ] Change optimizer run ids to `run-<uuid>` with no timestamp fallback.
- [ ] Add a Rust test/helper assertion for run id format if command-level testing is practical.
- [ ] Remove `remove_gps` from frontend-only state if it can be done without breaking serde command compatibility. If Rust request compatibility is too broad for this pass, leave Rust field but remove dead frontend refs and document in code that metadata is always stripped.
- [ ] Run Rust tests and frontend build.
- [ ] Commit: `chore: simplify run ids and metadata API`.

## Task 11: Small UX And Maintainability Cleanup

**Files:**
- Modify: `src/features/optimize/optimizeQueue.ts`
- Modify: `src/features/optimize/optimizeQueue.test.ts`
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify: `src/features/optimize/OptimizePage.test.tsx`

**Steps:**
- [ ] Add tests for `formatBytes(499)` and `formatBytes(999)`.
- [ ] Change `formatBytes` to show `< 1000` as bytes, for example `499 B`.
- [ ] Extract shared upload loop from `uploadToS3` and `retryUploads` into one internal function taking the items to upload.
- [ ] Preserve existing partial retry behavior with tests.
- [ ] Run optimize tests.
- [ ] Commit: `chore: clean optimize upload and byte formatting`.

## Final Verification

- [ ] Run:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test
PIC_PIPER_NO_KEYCHAIN=1 pnpm build
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo fmt --check
```

- [ ] Check `git status --short`.
- [ ] Check `git diff --stat` if anything remains unstaged.
