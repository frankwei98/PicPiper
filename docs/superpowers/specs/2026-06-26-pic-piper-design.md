# Pic Piper Design

Date: 2026-06-26

## Summary

Pic Piper is a Tauri desktop app for two related jobs:

1. Make images easier to share on the internet by resizing, adjusting quality, removing GPS metadata, and converting to efficient formats.
2. Upload images to a user-owned S3-compatible bucket and manage those uploaded images in a simplified gallery.

The two jobs must work independently. A user can optimize images without using S3, and they can manage/upload existing local images directly in the S3 Gallery. The pipeline path is explicit: optimize images, review compression results, click `Upload to S3`, then land in the S3 Gallery to copy URLs or manage uploaded objects.

First version non-goals:

- No auto-upload.
- No standalone upload queue page.
- No S3 object rename or move.
- No full local index of the bucket.
- No complete digital asset management features such as tags, favorites, public-link crawlers, or background folder watching.

## Product Shape

The first version is a desktop GUI-first tool. CLI automation is out of scope for this spec.

The main navigation has three entries:

- `Optimize`
- `S3 Gallery`
- `Settings`

`Optimize` and `S3 Gallery` are the primary work surfaces. Upload is an explicit action inside compression results or S3 Gallery, not a separate product area.

## Architecture

The current repository is a Tauri 2 + React + TypeScript starter app. The design keeps that split:

- React frontend: workspace layout, forms, previews, per-image controls, status display, and user actions.
- Rust/Tauri backend: filesystem access, image processing, S3-compatible API calls, credential storage, persistent local data, and command boundaries.

Core backend modules:

- `optimizer`: reads images, detects source format/dimensions/metadata, applies per-image compression settings, writes outputs, and returns size/quality results plus warnings.
- `profiles`: manages S3-compatible profiles and credential storage.
- `gallery`: lists S3 objects by profile and prefix, uploads local files, downloads objects, deletes objects, and builds public URLs.
- `history`: records local upload history only. It is not a bucket index.
- `settings`: stores presets, naming templates, default output folder, and default S3 profile/prefix choices.

Important boundary: the frontend should not handle raw S3 credentials or image codec work directly. It calls Tauri commands with structured inputs and renders returned task state.

## Optimize Workflow

The `Optimize` page supports single images and small batches, usually tens of images or fewer.

Flow:

1. User imports images by drag/drop or file picker.
2. App creates one image item per input file.
3. User applies a preset to initialize parameters in bulk.
4. User can override parameters on each image.
5. User clicks `Compress`.
6. App shows compression results.
7. User chooses one explicit next action:
   - `Save to local folder`
   - `Upload to S3`
   - `Back to edit settings`

The `Optimize` page itself has only two primary actions:

- `Apply preset`
- `Compress`

Saving locally and uploading to S3 are result-screen actions after compression completes.

## Per-Image Compression Controls

Presets are convenience defaults, not locked global state. Every imported image owns its own compression settings:

- Target format
- Quality percentage
- Maximum width/height
- Whether upscaling is allowed
- GPS metadata removal policy
- Output filename preview

Each image row/card shows:

- Source filename
- Source format and target format
- Original size
- Estimated output size before compression when available
- Actual output size after compression
- Compression ratio
- Quality slider
- Warnings or failure reason

Changing the quality slider should let the user explore the tradeoff between quality percentage and output size. The first version can implement this as an explicit re-estimate or preview action rather than continuous recompression on every slider movement.

## Image Processing Rules

Default goal: minimize file size for internet sharing while allowing slight visible quality loss.

Default metadata behavior:

- Remove GPS location metadata.
- Preserve other EXIF where the target format and encoder support it.
- If metadata cannot be preserved in the selected target format, show a result warning.

Format strategy:

- Built-in priority: JPG, PNG, WebP, AVIF.
- HEIF/HEIC support is capability-detected. If the runtime environment supports it, enable it. If not, show a per-image warning and let the rest of the batch continue.
- Photos should default toward WebP or AVIF.
- Transparent images should select among WebP, AVIF, and PNG based on compatibility and output result.
- JPG and PNG remain available for compatibility-focused output.

Batch behavior:

- One image failure must not stop the whole batch.
- Failed images keep their parameters and error message so the user can adjust and retry them.
- Compression results list successes, warnings, and failures separately enough that the user can act on them.

## S3 Gallery Workflow

`S3 Gallery` is a simplified manager for a selected S3-compatible profile and prefix.

Supported operations:

- Choose profile.
- Choose or enter prefix.
- Browse prefixes in a folder-like way.
- List objects from the current prefix in real time.
- Search/filter objects in the current prefix.
- Preview image objects in a grid.
- Upload local images.
- Download objects.
- Delete objects with confirmation.
- Copy public URL.
- Open/view an image.

Unsupported in v1:

- Rename.
- Move.
- Full bucket indexing.
- Tags, favorites, album management, or offline library behavior.

S3 does not provide true rename. Simulating rename/move requires copy object plus delete original, which adds partial-failure cases. That risk is intentionally excluded from v1.

After `Upload to S3` from compression results:

1. User selects or confirms profile, prefix, and naming template.
2. App uploads the compressed outputs immediately.
3. App records successful uploads in local history.
4. App opens or refreshes `S3 Gallery` at the target profile/prefix.
5. Newly uploaded objects are highlighted so the user can copy URLs, view, download, or delete them.

There is no auto-upload path. Upload starts only from an explicit user action.

## S3 Profiles And Credentials

Profiles target generic S3-compatible providers, including AWS S3, Cloudflare R2, Backblaze B2, and MinIO.

Each profile captures these connection fields:

- Profile name
- Endpoint
- Region
- Bucket
- Access key id
- Secret access key, stored through the credential-storage policy below
- Path-style or virtual-hosted-style addressing option
- Public Base URL
- Default prefix

Credential storage:

- Prefer system secure storage:
  - macOS Keychain
  - Windows Credential Manager
  - Linux Secret Service/libsecret
- Store only non-sensitive profile fields and secret references in app config when secure storage is available.
- If secure storage is unavailable, allow fallback to local config file storage.
- When using fallback storage, the UI must clearly mark the risk and allow migration back to secure storage later.

Public URL behavior:

- Public URLs are built as `Public Base URL + object key`.
- URL joining must normalize exactly one slash between the base URL and object key.
- If a profile has no Public Base URL, `Copy URL` should show a clear configuration error instead of assuming the bucket is public.
- Presigned URLs are out of scope for v1.

## Object Naming

Uploads use a configurable naming template. The default template is:

```text
{yyyy}/{mm}/{slug}-{hash}.{ext}
```

Template goals:

- Avoid collisions by default.
- Produce stable, readable URLs.
- Keep generated object keys safe for common S3-compatible providers and CDNs.

The Settings page lets the user edit the template. The app should validate the template before upload and show a preview object key for selected files.

If an upload would collide, v1 should default to generating a non-conflicting key rather than overwriting. Overwrite can be a deliberate user action if implemented, but it must not be the default.

## Local Data

The app stores only necessary local state:

- Non-sensitive profile config
- Presets
- Naming template
- Default output directory
- Upload history
- Thumbnail cache

Upload history records:

- Profile
- Bucket
- Object key
- Public URL if available
- Upload timestamp
- Source filename
- Compressed output filename
- Original size
- Uploaded size
- Target format

Upload history is for "recent uploads" and post-upload navigation. It is not a source of truth for bucket contents.

Thumbnail cache is disposable. S3 list results and object data remain authoritative.

## Error Handling

General rule: single-item failures do not block unrelated work.

Image errors:

- Unsupported input format
- Codec unavailable
- Corrupt image
- Metadata read/write failure
- Output write failure
- Size estimation failure

S3 errors:

- Invalid credentials
- Permission denied
- Network failure
- Bucket not found
- Endpoint/region mismatch
- Prefix empty or no objects found
- Public Base URL missing
- Upload collision
- Delete failure

The UI should categorize errors and offer concrete recovery actions where possible, such as editing credentials, changing endpoint, choosing another format, retrying one image, selecting another output folder, or setting a Public Base URL.

Deletes require confirmation. Failed deletes must leave the gallery state consistent with the latest known S3 response.

## Testing Strategy

Backend unit tests:

- Naming template rendering and validation
- Public URL joining
- Profile validation
- Credential-storage fallback decisions
- Metadata policy decisions
- Per-image compression setting serialization

Backend integration tests:

- S3-compatible list/upload/download/delete using MinIO or a mock S3 service
- Upload conflict handling
- Missing Public Base URL behavior
- Batch compression where one item fails and others succeed

Frontend tests:

- Importing image items
- Applying presets to selected/all images
- Overriding per-image settings
- Showing original size, estimated size, actual size, and warnings
- Compression result actions
- Upload-to-S3 transition into S3 Gallery
- Gallery prefix browsing, search, preview, copy URL, and delete confirmation

Cross-platform target:

- macOS, Windows, and Linux are all product targets.
- Secure credential storage must be tested separately per platform.
- The implementation plan can stage verification by platform, but the design must avoid macOS-only assumptions.

## Open Implementation Decisions

These are implementation choices for the next planning phase, not product ambiguity:

- Exact Rust image processing crate stack for WebP/AVIF and metadata preservation.
- Whether HEIF/HEIC support comes from an optional bundled decoder or runtime detection of system/external capability.
- Exact local storage format for settings and upload history.
- Whether S3 integration uses an AWS SDK crate or a smaller S3-compatible client.

The product behavior above should remain stable regardless of those choices.
