# Pic Piper

Pic Piper is a Tauri desktop app for optimizing images for internet sharing and uploading them to an S3-compatible bucket.

## Features

### Optimize

- Choose real image files (JPG, PNG, WebP, AVIF, HEIF/HEIC).
- Each file is inspected through the backend for format, dimensions, and size.
- Tune quality, target format, max dimensions, and GPS removal per image.
- Compress images through the backend encoder.
- Save compressed outputs to a user-selected local folder.

### S3 Gallery

- Configure S3-compatible profiles (AWS S3, Cloudflare R2, Backblaze B2, MinIO).
- Browse objects by profile and prefix.
- Search/filter objects in the current prefix.
- Copy public URLs, view in browser, download, and delete objects.
- Upload local images directly to S3.

### Settings

- Add and edit S3-compatible profiles.
- Credentials stored locally on this device.
- Configure naming template, default prefix, and public base URL.
- Settings persist across app restarts.

### Upload Workflow

- After compressing images in Optimize, click "Upload to S3" to upload.
- Object keys are generated from the naming template with content hash.
- After upload, the app opens S3 Gallery at the target prefix with uploaded objects highlighted.

## S3 Configuration

1. Open Settings.
2. Enter your S3 endpoint, region, bucket, and access key ID.
3. Enter the secret access key (stored locally on this device).
4. Set a Public Base URL for copy-URL functionality (e.g., `https://cdn.example.com`).
5. Set a default prefix (e.g., `images/2026/06`).
6. Click "Save profile".

## Development

```bash
pnpm install
pnpm test
pnpm build
pnpm tauri dev
```

Rust tests:

```bash
cd src-tauri
cargo test
cargo fmt --check
```

## Known v1 Limits

- No auto-upload.
- No standalone upload queue.
- No S3 rename/move.
- No presigned URLs.
- No full bucket indexing.
- No tags, favorites, or folder watching.
