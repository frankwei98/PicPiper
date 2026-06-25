# Pic Piper

Pic Piper is a Tauri desktop app for optimizing images for internet sharing and uploading them to an S3-compatible bucket.

## First version scope

- Optimize single images and small batches.
- Tune format, quality, size, and GPS removal per image.
- Save compressed results locally.
- Upload compressed results to S3 with an explicit action.
- Browse a simplified S3 Gallery by profile and prefix.
- Copy public URLs, view, upload, download, and delete image objects.

Out of scope for v1: auto-upload, standalone upload queue, S3 rename/move, presigned URLs, full bucket indexing, tags, favorites, and folder watching.

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
```
