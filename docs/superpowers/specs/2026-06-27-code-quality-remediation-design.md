# Pic Piper Code Quality Remediation Design

## Goal

Fix the confirmed security, correctness, data-loss, error-visibility, persistence, and type-boundary defects found in the Pic Piper audit, while keeping the existing product scope intact: optimize images, save local outputs, upload to S3/R2, browse the gallery, and manage S3 profiles.

## Non-Goals

- Do not add auto-upload.
- Do not add a standalone queue page.
- Do not add rename or move operations in the gallery.
- Do not reintroduce resize controls.
- Do not rewrite the UI framework or redesign the whole app.
- Do not treat Access Key ID as a secret equal to Secret Access Key; it should be handled carefully, but the urgent secret risk is fallback secret storage.

## Confirmed Problems To Fix

### P0/P1 Security And Data Safety

1. `credentials.rs` writes fallback secret files using unvalidated `profile_id`, allowing path traversal outside the fallback directory. Fallback files also need owner-only permissions where supported.
2. Local save and gallery download overwrite existing files without confirmation or unique-name protection.
3. S3 object keys and public URLs are not normalized consistently. Generated keys should reject control characters and unsafe path segments; public URLs must percent-encode key path segments.
4. `removeGps=false` is misleading because image re-encoding currently drops EXIF/GPS regardless of the flag.
5. S3 listing reads only the first `list_objects_v2` page.

### P1 Correctness And UX

6. Optimize scheduling can start multiple compression jobs for the same item after global requeue.
7. Upload retry re-uploads already successful compressed items after a partial failure.
8. Delete failures close the confirmation dialog and leave no visible error.
9. Upload history append failures are swallowed.
10. Settings and gallery state claim multi-profile support but effectively operate on stale or first-profile-only state.
11. `tauriApi.inspectImage` is typed as `OptimizeItem` even though Rust returns `ImageInspection`.

### P2 Robustness And Maintainability

12. Settings and history writes are non-atomic.
13. Async commands contain some blocking filesystem calls and large downloads are collected entirely into memory.
14. Optimizer cache directories are never cleaned up.
15. macOS thumbnail FFI needs safer signatures/comments or isolation.
16. Shared model types lack serde defaults/migration tolerance.
17. Error model has unused fields and repetitive mapping.
18. Repeated UI class constants and mixed input/output image format types should be cleaned up when touched.
19. Existing tests miss the audited failure paths.

## Design

### Backend Validation Layer

Add focused helpers instead of spreading ad hoc validation:

- `credentials::validate_profile_id(profile_id) -> AppResult<&str>` accepts only a conservative ASCII identifier set such as letters, digits, `_`, `-`, and `.`; rejects empty strings, path separators, `..`, and control characters.
- `naming::validate_object_key(key) -> AppResult<String>` normalizes backslashes to `/`, rejects empty keys, `.` and `..` path segments, leading slash, duplicate slash, and ASCII control characters.
- `gallery::public_url(profile, key)` percent-encodes each path segment but preserves `/` separators.
- `optimizer::unique_destination_path(target_dir, file_name)` returns a non-existing path by appending `-2`, `-3`, etc.

These helpers must have regression tests before implementation.

### Secret Fallback

Fallback secret storage remains a development escape hatch, not secure production storage. The fix is:

- Validate `profile_id` before save/load.
- Write fallback files atomically.
- On Unix/macOS, create fallback files with `0600` permissions.
- Keep Keychain as the default path.

### Object Key And URL Handling

Generated object keys must be valid S3 keys for this app. The naming template can still include date, slug, hash, and extension, but the final key must pass validation. Prefix detection must use path segment boundaries:

- Prefix `img` does not match rendered `images/a.webp`.
- Prefix `images` matches `images/a.webp`.
- Prefix `images/` is normalized to `images`.

Public URLs must encode segment content:

- `photos/a b.webp` becomes `photos/a%20b.webp`.
- `photos/a#b.webp` becomes `photos/a%23b.webp`.
- `/` remains a separator.

### Filesystem Writes

User-facing writes must not overwrite existing files silently:

- `copy_outputs_to_dir` should pick unique destination names.
- `download_object` should pick a unique destination name in the chosen directory or reject an explicit existing path, depending on API shape.
- Settings and history writes should use temp-file plus rename.

### Metadata Semantics

Because current compression does not preserve EXIF, the UI and warnings must stop implying that disabling Remove GPS preserves GPS. The pragmatic fix is to rename or clarify the control so users know metadata is removed during re-encoding. If true metadata preservation is implemented later, it should be a separate feature with tests using real EXIF fixtures.

### S3 Operations

S3 listing must loop through continuation tokens until `is_truncated` is false. Upload retry should track per-item upload state:

- `pending`, `uploading`, `uploaded`, `failed`.
- Retrying only uploads failed or never-attempted items.
- Successfully uploaded keys remain available for gallery focus.

### Multi-Profile State

Use `settings.defaultProfileId` when choosing the active profile. `SettingsPage` should let the user select which profile to edit, or make the single-profile limitation explicit and remove multi-profile assumptions. Since gallery already has a profile selector, the better fix is:

- Add profile selection to Settings.
- Persist `defaultProfileId`.
- Sync `S3GalleryPage` local selected profile and prefix when `galleryFocus` changes.
- Store `GalleryFocus` by `profileId` rather than a full stale `S3Profile` snapshot.

### Type Boundaries

Create accurate TypeScript API types:

- `ImageInspection` mirrors Rust `ImageInspection`.
- `WritableImageFormat = "jpg" | "png" | "webp" | "avif"`.
- `ReadableImageFormat = WritableImageFormat | "heif"`.
- Upload `targetFormat` should use writable output format, not arbitrary string.

### Error Visibility

Do not swallow user-relevant errors:

- Delete errors render a `StatusMessage` and keep enough context for retry.
- History append failures should either return a warning to the frontend or log to stderr/tracing.
- Empty catch blocks should be replaced with explicit best-effort comments only where acceptable, and unexpected setup failures should be visible in development.

### Tests

Required regression tests:

- Credential profile id traversal rejected on save and load.
- Fallback secret file permissions are owner-only on Unix/macOS.
- Public URL encodes spaces, `#`, and Unicode.
- Object key validation rejects `..`, empty segments, leading slash, control characters, and backslash after normalization.
- Prefix boundary behavior.
- Copy/download unique destination behavior.
- S3 list pagination with mocked client boundary or extracted pagination function.
- Remove GPS UI/warning semantics.
- Compression scheduler does not dispatch duplicate item ids.
- Partial upload retry skips already uploaded items.
- Delete failure path renders error.
- Gallery focus profile changes sync selected profile and prefix.
- Settings can edit the selected profile and honors default profile id.
- API type tests or component tests no longer need `unknown as Record` for `inspectImage`.

## Verification

Before completion, run:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test
PIC_PIPER_NO_KEYCHAIN=1 pnpm build
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo fmt --check
```

For any UI-affecting changes, run a local app smoke test with `pnpm dev` or `pnpm tauri dev` if time allows.
