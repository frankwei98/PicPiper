# Pic Piper Code Quality Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all confirmed Pic Piper audit issues across security, data safety, S3 correctness, optimizer scheduling, multi-profile state, API typing, persistence, and test coverage.

**Architecture:** Add small backend validation/persistence helpers first, then fix S3/filesystem behavior, then repair frontend state machines and type boundaries. Each task starts with a regression test and ends with targeted verification plus a small commit.

**Tech Stack:** Tauri 2, Rust, React 19, TypeScript, Vitest, Testing Library, AWS SDK for Rust, macOS Keychain via `keyring`.

---

## Execution Rules

- Work from `/Users/frankwei/Code/DesktopApp/pic-piper`.
- Do not touch unrelated dirty files.
- Use `PIC_PIPER_NO_KEYCHAIN=1` for local tests.
- Prefer one commit per task.
- Do not broaden product scope: no auto-upload, no separate queue page, no resize controls, no gallery rename/move.
- If using parallel agents, assign one task group per agent and merge only after its verification commands pass.

## Task Groups

### Task 1: Credential Fallback Hardening

**Files:**
- Modify: `src-tauri/src/credentials.rs`
- Test: `src-tauri/src/credentials.rs`

**Steps:**
- [ ] Add tests rejecting `../evil`, `a/b`, `a\\b`, empty string, and control characters for `profile_id`.
- [ ] Add a Unix/macOS test asserting fallback file mode is not group/world-readable.
- [ ] Implement `validate_profile_id`.
- [ ] Use it in `credential_ref`, `save_secret_with_keyring`, and `load_secret`.
- [ ] Write fallback files via temp file then rename.
- [ ] On Unix/macOS, set file permissions to `0o600`.
- [ ] Run `cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test credentials`.
- [ ] Commit: `fix: harden credential fallback storage`.

### Task 2: Object Key And URL Normalization

**Files:**
- Modify: `src-tauri/src/naming.rs`
- Modify: `src-tauri/src/gallery.rs`
- Modify: `src-tauri/src/lib.rs`

**Steps:**
- [ ] Add `naming` tests for invalid keys: `../a.webp`, `/a.webp`, `a//b.webp`, `a/\n.webp`, `a/../b.webp`, and backslash normalization.
- [ ] Add prefix-boundary tests: prefix `img` must not match `images/a.webp`; prefix `images` must match `images/a.webp`.
- [ ] Add `gallery::public_url` tests for spaces, `#`, and Unicode.
- [ ] Implement `validate_object_key` and call it from `generate_object_key` before returning.
- [ ] Replace string `starts_with` prefix logic with path-segment-aware prefixing.
- [ ] Percent-encode public URL key segments while preserving `/`.
- [ ] Run `cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test naming gallery`.
- [ ] Commit: `fix: validate object keys and encode public urls`.

### Task 3: No Silent Local Overwrites

**Files:**
- Modify: `src-tauri/src/optimizer.rs`
- Modify: `src-tauri/src/gallery.rs`
- Modify: `src/features/gallery/S3GalleryPage.tsx`
- Test: Rust module tests and gallery component tests if API shape changes.

**Steps:**
- [ ] Add Rust tests proving `copy_outputs_to_dir` writes `photo.webp`, `photo-2.webp`, etc. when the target already exists.
- [ ] Add a Rust test for download destination helper choosing a unique filename.
- [ ] Extract `unique_destination_path(target_dir, file_name)`.
- [ ] Use it in `copy_outputs_to_dir`.
- [ ] Change download request/API if needed so frontend sends a directory and backend returns the final unique output path.
- [ ] Surface successful download path in Gallery UI.
- [ ] Run targeted Rust tests and `PIC_PIPER_NO_KEYCHAIN=1 pnpm test -- src/features/gallery/S3GalleryPage.test.tsx`.
- [ ] Commit: `fix: avoid overwriting saved and downloaded files`.

### Task 4: S3 Listing Pagination

**Files:**
- Modify: `src-tauri/src/gallery.rs`

**Steps:**
- [ ] Extract pure object mapping if needed so pagination can be tested without real S3.
- [ ] Add test coverage for merging two pages and preserving `last_modified`, `size`, and `is_image`.
- [ ] Implement continuation token loop until `is_truncated` is false.
- [ ] Keep public URL behavior from Task 2.
- [ ] Run `cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test gallery`.
- [ ] Commit: `fix: paginate s3 gallery listings`.

### Task 5: Metadata/GPS Semantics

**Files:**
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify: `src/features/optimize/OptimizePage.test.tsx`
- Modify: `src-tauri/src/optimizer.rs`
- Test: Rust optimizer tests and frontend optimize tests.

**Steps:**
- [ ] Decide pragmatic behavior: current encoder always strips metadata.
- [ ] Rename/clarify UI copy from “Remove GPS” to metadata-stripping language, or disable the setting and always show “Metadata is removed during compression.”
- [ ] Change Rust warning so it no longer depends on `remove_gps` for false claims.
- [ ] Add frontend test that disabling the checkbox does not imply GPS preservation.
- [ ] Add Rust test for warning behavior.
- [ ] Run `PIC_PIPER_NO_KEYCHAIN=1 pnpm test -- src/features/optimize/OptimizePage.test.tsx` and `cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test optimizer`.
- [ ] Commit: `fix: clarify metadata stripping behavior`.

### Task 6: Optimize Scheduler Duplicate Dispatch

**Files:**
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify: `src/features/optimize/OptimizePage.test.tsx`
- Modify: `src/features/optimize/optimizeQueue.ts` if helper extraction is useful.

**Steps:**
- [ ] Add a test that changes quality while an item is compressing and asserts `compressImage` is not called twice for the same active task.
- [ ] Filter `nextItems` with `!activeTasks.current.has(item.id)`.
- [ ] Ensure stale results are ignored through `taskVersion`.
- [ ] Remove unused `quality`/`removeGps` effect dependencies if no longer read.
- [ ] Run targeted optimize tests.
- [ ] Commit: `fix: prevent duplicate compression dispatch`.

### Task 7: Partial Upload Retry State

**Files:**
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify: `src/features/optimize/OptimizePage.test.tsx`

**Steps:**
- [ ] Add tests for three compressed items where item A uploads, item B fails, then retry only uploads B and any never-attempted items.
- [ ] Track upload state per item: uploading, uploaded key, failed error.
- [ ] Change retry logic to skip already uploaded items.
- [ ] Keep gallery focus highlighting both previous successes and new retry successes.
- [ ] Run targeted optimize tests.
- [ ] Commit: `fix: retry only failed uploads`.

### Task 8: Delete And History Error Visibility

**Files:**
- Modify: `src/features/gallery/S3GalleryPage.tsx`
- Modify: `src/features/gallery/S3GalleryPage.test.tsx`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/history.rs`

**Steps:**
- [ ] Add Gallery test where delete rejects and an error status is rendered.
- [ ] Stop wrapping confirm action in a close-only control if it prevents async error handling.
- [ ] Keep dialog open or show a visible error after failure.
- [ ] Change `upload_gallery_object` to report history append failure as a warning or log it explicitly. If returned as warning, update the frontend type.
- [ ] Run gallery tests and Rust history/lib tests.
- [ ] Commit: `fix: surface gallery operation errors`.

### Task 9: Multi-Profile State Repair

**Files:**
- Modify: `src/types.ts`
- Modify: `src/state/appState.ts`
- Modify: `src/App.tsx`
- Modify: `src/features/settings/SettingsPage.tsx`
- Modify: `src/features/settings/SettingsPage.test.tsx`
- Modify: `src/features/gallery/S3GalleryPage.tsx`
- Modify: `src/features/gallery/S3GalleryPage.test.tsx`

**Steps:**
- [ ] Change `GalleryFocus` to store `profileId?: string` instead of a full `S3Profile` snapshot.
- [ ] Resolve active/default profile by `settings.defaultProfileId`, falling back to first profile.
- [ ] Add Settings profile selector and edit the selected profile instead of hard-coded `profiles[0]`.
- [ ] Persist `defaultProfileId` when saving the selected/default profile.
- [ ] Add effect in Gallery to sync selected profile and prefix when `galleryFocus.profileId` or `galleryFocus.prefix` changes.
- [ ] Add tests for editing second profile and gallery focus switching.
- [ ] Run settings/gallery/App tests.
- [ ] Commit: `fix: synchronize multi-profile state`.

### Task 10: Accurate API And Format Types

**Files:**
- Modify: `src/types.ts`
- Modify: `src/api/tauri.ts`
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify: `src/features/optimize/optimizeQueue.ts`
- Modify: related tests.

**Steps:**
- [ ] Add `WritableImageFormat = "jpg" | "png" | "webp" | "avif"`.
- [ ] Add `ReadableImageFormat = WritableImageFormat | "heif"`.
- [ ] Add `ImageInspection` TypeScript interface matching Rust response.
- [ ] Change `tauriApi.inspectImage` to return `ImageInspection`.
- [ ] Remove `unknown as Record` parsing in `OptimizePage`.
- [ ] Type upload `targetFormat` as `WritableImageFormat`.
- [ ] Ensure HEIF can be read/imported but not selected as output.
- [ ] Run `PIC_PIPER_NO_KEYCHAIN=1 pnpm build` and optimize tests.
- [ ] Commit: `fix: align frontend tauri api types`.

### Task 11: Atomic Settings And History Writes

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/history.rs`

**Steps:**
- [ ] Add tests proving a valid existing settings/history file remains readable if temp-write fails where practical.
- [ ] Implement helper `write_json_atomic(path, content)`.
- [ ] Use temp file in same directory and rename.
- [ ] Ensure parent directory creation remains.
- [ ] Run `cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test settings history`.
- [ ] Commit: `fix: write settings and history atomically`.

### Task 12: Resource And Cache Hygiene

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/gallery.rs`
- Modify: `src-tauri/src/state.rs` if paths are needed.

**Steps:**
- [ ] Add cache cleanup helper that deletes old `optimizer-cache/run-*` directories older than a conservative threshold, such as 7 days.
- [ ] Call cleanup opportunistically when creating a new optimizer run.
- [ ] Replace easy blocking filesystem calls in async commands with `tokio::fs` where it does not force a large refactor.
- [ ] For downloads, avoid collecting very large objects into memory if AWS SDK body can be streamed to a file.
- [ ] Run Rust tests.
- [ ] Commit: `fix: clean optimizer cache and reduce blocking io`.

### Task 13: Thumbnail FFI And Error Model Cleanup

**Files:**
- Modify: `src-tauri/src/thumbnail.rs`
- Modify: `src-tauri/src/error.rs`
- Modify: callers only where needed.

**Steps:**
- [ ] Add `// SAFETY:` comments for each macOS unsafe block.
- [ ] Correct FFI pointer types if current signatures are inaccurate for ImageIO.
- [ ] Keep CPU fallback tests passing.
- [ ] Remove unused `fatal` if still unused, or make `recoverable` meaningful in UI.
- [ ] Add `From<std::io::Error>` only if it reduces repeated incorrect mappings without obscuring error codes.
- [ ] Run `cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test thumbnail error`.
- [ ] Commit: `chore: tighten thumbnail ffi and errors`.

### Task 14: UI Class And Accessibility Polish

**Files:**
- Create: `src/components/ui/buttonStyles.ts` or similar.
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify: `src/features/gallery/S3GalleryPage.tsx`
- Modify: `src/features/settings/SettingsPage.tsx`
- Modify: `src/components/ui/Dialog.tsx`
- Modify: `src/components/Layout.tsx`

**Steps:**
- [ ] Extract shared button/input class constants used by feature screens.
- [ ] Add missing focus-visible styles to dialog danger/secondary buttons.
- [ ] Replace decorative `aria-label` on non-interactive brand icon with `aria-hidden="true"`.
- [ ] Add clearer aria labels to ambiguous icon/remove/retry buttons where labels are not descriptive.
- [ ] Run frontend tests and build.
- [ ] Commit: `chore: consolidate ui controls and accessibility`.

### Task 15: Final Coverage And Verification

**Files:**
- Modify tests as needed.
- No product code unless a failing test reveals a missed defect.

**Steps:**
- [ ] Add missing regression tests from the audit list not already covered: highlighted keys rendering, search filtering, load settings failure branch, partial upload retry, delete failure, multi-profile selection, profile id traversal.
- [ ] Run full frontend tests:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test
```

- [ ] Run frontend build:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm build
```

- [ ] Run Rust tests:

```bash
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test
```

- [ ] Run Rust formatting:

```bash
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo fmt --check
```

- [ ] Review `git diff --stat` and `git status --short` to confirm only intended files changed.
- [ ] Commit final test-only or cleanup changes if any: `test: cover audited pic piper regressions`.

## Suggested Parallel Dispatch

- Agent A: Tasks 1, 2, 11.
- Agent B: Tasks 3, 4, 12.
- Agent C: Tasks 5, 6, 7, 10.
- Agent D: Tasks 8, 9, 14.
- Main agent: Task 15 and final integration conflict resolution.

Agents must not edit the same files concurrently without coordination. `OptimizePage.tsx`, `S3GalleryPage.tsx`, and `SettingsPage.tsx` are hot files; serialize merges touching those files.
