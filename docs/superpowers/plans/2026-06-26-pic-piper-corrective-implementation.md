# Pic Piper Corrective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace the current mock UI shell with a usable Pic Piper MVP where settings persist, image files are really imported and compressed, S3 Gallery really lists/uploads/downloads/deletes objects, and `Upload to S3` from compression results performs a real backend upload before opening the gallery.

**Architecture:** Treat the existing backend commands as partial infrastructure, not finished product. Frontend pages must stop using `SAMPLE_ITEMS` and `SAMPLE_OBJECTS`, must call typed Tauri APIs for real work, and must render explicit loading/error/empty states. Add regression tests that fail whenever a user-visible path is backed only by static sample data.

**Tech Stack:** Tauri 2, React 19, TypeScript, Vite, Vitest, Testing Library, Rust 2021, `image`, `aws-sdk-s3`, `keyring`, local JSON settings/history, Tauri dialog/opener plugins.

---

## Current Failure Assessment

The previous implementation marked all plan tasks complete, but it did not build the MVP described in `docs/superpowers/specs/2026-06-26-pic-piper-design.md`.

Evidence in the current code:

- `src/features/optimize/OptimizePage.tsx` initializes from `SAMPLE_ITEMS` with `/sample/photo-01.jpg`.
- `OptimizePage` never calls `tauriApi.inspectImage` or `tauriApi.compressImage`.
- `Compress` only switches React state to the results view.
- `Save to local folder` has no handler.
- `Upload to S3` tries to upload `item.outputPath ?? item.sourcePath`, but no real compressed `outputPath` exists for sample data.
- `src/features/gallery/S3GalleryPage.tsx` renders `SAMPLE_OBJECTS`.
- `S3GalleryPage` never calls `galleryApi.listObjects`, `delete_gallery_object`, download, or upload-local commands.
- `src/features/settings/SettingsPage.tsx` ignores its props through `_props`; the form never saves settings or credentials.
- `src/App.tsx` creates local default settings but never calls `settingsApi.loadSettings`.
- Frontend type `S3ProfileSummary` is not compatible with Rust `S3Profile`; it lacks `accessKeyId`, `credentialRef`, `pathStyle`, and `insecureSecretFallback`.
- Tests pass because they assert sample text and button presence, not real workflows.

Root cause:

The implementation followed a skeleton plan literally and then marked the checklist complete. The test suite failed to require real data flow across the React/Tauri boundary.

## Corrective Spec

This corrective pass keeps the approved product scope:

- Main pages: `Optimize`, `S3 Gallery`, `Settings`.
- No auto-upload.
- No standalone upload queue.
- No S3 rename/move.
- No presigned URLs.
- No full bucket index.

The MVP is acceptable only when these workflows work:

1. **Settings workflow**
   - User enters an S3-compatible profile.
   - User can choose secure secret storage or explicit local fallback.
   - App saves non-secret settings with `save_app_settings`.
   - App saves the secret with `save_s3_secret`.
   - App loads saved settings on startup with `load_app_settings`.
   - The selected profile is available to `Optimize` and `S3 Gallery`.

2. **Optimize workflow**
   - User can choose one or more real image files.
   - Each chosen file is inspected through the Tauri backend.
   - Each image row shows real source filename, source format, dimensions, original size, estimated size, and per-image settings.
   - `Apply preset` updates each selected/imported image's settings.
   - `Compress` calls backend compression and creates real output files in an app-managed temporary/cache directory.
   - Results show real output paths, output sizes, compression ratio, warnings, and failures.
   - `Save to local folder` copies real compressed outputs into a user-selected directory.

3. **Optimize to S3 workflow**
   - `Upload to S3` is enabled only when compressed outputs exist and an S3 profile is selected.
   - Clicking `Upload to S3` uploads the compressed output files through the backend.
   - Object keys use the configured naming template and default prefix.
   - Successful uploads append local upload history.
   - After upload, the app opens `S3 Gallery` at the target profile/prefix and highlights the newly uploaded keys.

4. **S3 Gallery workflow**
   - User selects a saved profile and prefix.
   - Gallery calls backend `list_gallery_objects`.
   - Gallery filters/searches the current list client-side.
   - `Copy URL` copies the public URL or shows the missing `Public Base URL` error.
   - `View` opens the public URL when available.
   - `Download` saves an S3 object to a user-selected folder.
   - `Delete` confirms, calls backend delete, then refreshes the current prefix.
   - `Upload local images` chooses local files, uploads them using the naming template, refreshes the current prefix, and highlights uploaded keys.

5. **UI quality**
   - Remove fake data from user-visible pages.
   - Remove `body { min-width: 960px; }`; the app must not horizontally overflow at the default 800x600 Tauri window.
   - Settings form must be usable in one column or a responsive two-column layout.
   - Buttons that cannot work yet must be disabled with a visible reason, not silently present.
   - Loading, empty, and error states must be visible and specific.

## File Structure

Expected files to modify:

- `package.json`: add any missing Tauri plugin frontend packages.
- `src-tauri/Cargo.toml`: add matching Tauri plugin backend crates and test helpers.
- `src-tauri/src/lib.rs`: register any new commands/plugins.
- `src-tauri/src/models.rs`: align request/response models with frontend types.
- `src-tauri/src/optimizer.rs`: add batch/cache compression and copy-to-folder support.
- `src-tauri/src/gallery.rs`: add download, object-key generation if kept server-side, and history appending.
- `src-tauri/src/settings.rs`: preserve settings persistence; add validation helpers if needed.
- `src-tauri/src/history.rs`: ensure uploads call `append_history`.
- `src-tauri/src/naming.rs`: expose object-key rendering through a command or use it inside upload commands.
- `src/api/tauri.ts`: expose all real backend commands behind typed wrappers.
- `src/types.ts`: replace `S3ProfileSummary` with a frontend `S3Profile` that matches Rust `S3Profile`.
- `src/App.tsx`: load/save settings, keep selected profile/prefix, and handle post-upload gallery focus.
- `src/features/settings/SettingsPage.tsx`: controlled settings form that saves settings and credentials.
- `src/features/optimize/OptimizePage.tsx`: real import/inspect/compress/save/upload flow.
- `src/features/gallery/S3GalleryPage.tsx`: real list/upload/download/delete/copy/view flow.
- `src/App.css`: responsive layout and state styling.
- `src/**/*.test.tsx`: replace shallow button tests with workflow tests.
- `src-tauri/src/*` tests: add backend tests around batch compression, settings validation, object-key generation, and history appending.

## Task 1: Guardrails Against Mock-Only Completion

**Files:**
- Modify: `src/features/optimize/OptimizePage.test.tsx`
- Modify: `src/features/gallery/S3GalleryPage.test.tsx`
- Modify: `src/features/settings/SettingsPage.test.tsx` or create it if absent
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify: `src/features/gallery/S3GalleryPage.tsx`

- [x] **Step 1: Add failing tests that reject sample-only UI**

In `src/features/optimize/OptimizePage.test.tsx`, add tests that expect an empty initial state and real import action:

```tsx
it("starts empty and asks the user to choose images", () => {
  render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

  expect(screen.getByText(/choose images/i)).toBeInTheDocument();
  expect(screen.queryByText("photo-01.jpg")).not.toBeInTheDocument();
  expect(screen.queryByText("/sample/photo-01.jpg")).not.toBeInTheDocument();
});

it("keeps Compress disabled until at least one image is inspected", () => {
  render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

  expect(screen.getByRole("button", { name: "Compress" })).toBeDisabled();
});
```

In `src/features/gallery/S3GalleryPage.test.tsx`, add:

```tsx
it("does not render sample objects before a profile is selected and loaded", () => {
  render(<S3GalleryPage galleryFocus={{ prefix: "", highlightedKeys: [] }} profiles={[]} />);

  expect(screen.getByText(/no profile selected/i)).toBeInTheDocument();
  expect(screen.queryByText("2026/06/photo-01-abcdef12.webp")).not.toBeInTheDocument();
});
```

Create `src/features/settings/SettingsPage.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { SettingsPage } from "./SettingsPage";

describe("SettingsPage", () => {
  it("renders a save action for profile settings", () => {
    render(
      <SettingsPage
        settings={{
          profiles: [],
          presets: [],
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
        }}
        onSettingsChange={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /save profile/i })).toBeInTheDocument();
  });
});
```

- [x] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm test -- src/features/optimize/OptimizePage.test.tsx src/features/gallery/S3GalleryPage.test.tsx src/features/settings/SettingsPage.test.tsx
```

Expected: FAIL because current pages render sample data and Settings has no save action.

- [x] **Step 3: Remove sample data constants**

Delete these constants:

- `SAMPLE_ITEMS` from `src/features/optimize/OptimizePage.tsx`
- `SAMPLE_OBJECTS` from `src/features/gallery/S3GalleryPage.tsx`

Initialize `OptimizePage` items as an empty array:

```tsx
const [items, setItems] = useState<OptimizeItem[]>([]);
```

Initialize `S3GalleryPage` objects as an empty array:

```tsx
const [objects, setObjects] = useState<GalleryObject[]>([]);
```

- [x] **Step 4: Disable impossible actions**

`Compress` must be disabled when there are no ready/pending imported items:

```tsx
const canCompress = items.some((item) => item.status === "ready" || item.status === "pending");
```

Render:

```tsx
<button type="button" disabled={!canCompress} onClick={handleCompress}>
  Compress
</button>
```

`S3GalleryPage` must render:

```tsx
{profiles.length === 0 && <section className="empty-state">No profile selected.</section>}
```

- [x] **Step 5: Verify and commit**

Run:

```bash
pnpm test -- src/features/optimize/OptimizePage.test.tsx src/features/gallery/S3GalleryPage.test.tsx src/features/settings/SettingsPage.test.tsx
pnpm test
pnpm build
```

Expected: tests pass and no user-visible sample object remains.

Commit:

```bash
git add src
git commit -m "test: prevent mock-only Pic Piper UI"
```

## Task 2: Align Frontend Types With Rust Models

**Files:**
- Modify: `src/types.ts`
- Modify: `src/api/tauri.ts`
- Modify: `src/App.tsx`
- Modify: `src/features/gallery/S3GalleryPage.tsx`
- Modify: `src/features/optimize/OptimizePage.tsx`

- [x] **Step 1: Replace `S3ProfileSummary` with `S3Profile`**

In `src/types.ts`, replace the existing `S3ProfileSummary` interface with:

```ts
export interface S3Profile {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  credentialRef?: string;
  pathStyle: boolean;
  publicBaseUrl?: string;
  defaultPrefix: string;
  insecureSecretFallback: boolean;
}
```

Update every import and prop currently using `S3ProfileSummary` to use `S3Profile`.

- [x] **Step 2: Fix API wrapper request types**

In `src/api/tauri.ts`, import `S3Profile` and use it in:

```ts
export interface ListGalleryObjectsRequest {
  profile: S3Profile;
  prefix: string;
}

export interface UploadObjectRequest {
  profile: S3Profile;
  sourcePath: string;
  objectKey: string;
  contentType?: string;
}
```

Add missing wrappers:

```ts
export interface DeleteObjectRequest {
  profile: S3Profile;
  key: string;
}

export interface DownloadObjectRequest {
  profile: S3Profile;
  key: string;
  outputPath: string;
}

export const galleryApi = {
  listObjects: (request: ListGalleryObjectsRequest) =>
    invoke<GalleryObject[]>("list_gallery_objects", { request }),
  deleteObject: (request: DeleteObjectRequest) =>
    invoke<void>("delete_gallery_object", { request }),
  downloadObject: (request: DownloadObjectRequest) =>
    invoke<string>("download_gallery_object", { request }),
};
```

The `download_gallery_object` backend command is added in Task 6. It is acceptable for TypeScript to fail until that task if the wrapper is imported; keep it unused until Task 6 if needed.

- [x] **Step 3: Verify no incompatible profile type remains**

Run:

```bash
rg -n "S3ProfileSummary|accessKeyId|pathStyle|insecureSecretFallback" src
pnpm build
```

Expected: no `S3ProfileSummary` remains; `pnpm build` passes after all imports are corrected.

Commit:

```bash
git add src
git commit -m "fix: align frontend S3 profile type with backend"
```

## Task 3: Real Settings Load, Save, And Credential Flow

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/features/settings/SettingsPage.tsx`
- Modify: `src/features/settings/SettingsPage.test.tsx`
- Modify: `src/api/tauri.ts`
- Modify: `src/App.css`

- [x] **Step 1: Add tests for load/save flow**

Mock `settingsApi` in `src/features/settings/SettingsPage.test.tsx`:

```tsx
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

const saveSettings = vi.fn(async () => {});
const saveS3Secret = vi.fn(async () => ({
  credentialRef: "s3:personal",
  insecureFallbackUsed: false,
}));

vi.mock("../../api/tauri", async () => ({
  settingsApi: {
    saveSettings,
    saveS3Secret,
  },
}));
```

Add:

```tsx
it("saves a profile and stores the secret through the credential API", async () => {
  const user = userEvent.setup();
  const onSettingsChange = vi.fn();

  render(
    <SettingsPage
      settings={{
        profiles: [],
        presets: [],
        namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
      }}
      onSettingsChange={onSettingsChange}
    />,
  );

  await user.clear(screen.getByLabelText("Profile name"));
  await user.type(screen.getByLabelText("Profile name"), "Personal R2");
  await user.type(screen.getByLabelText("Endpoint"), "https://example.r2.cloudflarestorage.com");
  await user.clear(screen.getByLabelText("Region"));
  await user.type(screen.getByLabelText("Region"), "auto");
  await user.type(screen.getByLabelText("Bucket"), "images");
  await user.type(screen.getByLabelText("Access key ID"), "access-key");
  await user.type(screen.getByLabelText("Secret access key"), "secret-key");
  await user.type(screen.getByLabelText("Public Base URL"), "https://cdn.example.com");
  await user.type(screen.getByLabelText("Default prefix"), "images/2026/06");

  await user.click(screen.getByRole("button", { name: /save profile/i }));

  expect(saveS3Secret).toHaveBeenCalledWith({
    profileId: expect.any(String),
    secretAccessKey: "secret-key",
    allowInsecureFallback: false,
  });
  expect(saveSettings).toHaveBeenCalled();
  expect(onSettingsChange).toHaveBeenCalled();
});
```

- [x] **Step 2: Run test and verify failure**

Run:

```bash
pnpm test -- src/features/settings/SettingsPage.test.tsx
```

Expected: FAIL because SettingsPage does not save.

- [x] **Step 3: Implement controlled SettingsPage**

`SettingsPage` must:

- Use controlled local state for profile fields.
- Generate a stable profile id from profile name or `crypto.randomUUID()`.
- Call `settingsApi.saveS3Secret` when a secret value is present.
- Save `credentialRef` and `insecureSecretFallback` onto the profile.
- Call `settingsApi.saveSettings`.
- Call `onSettingsChange` with the saved settings.
- Clear the secret input after successful save.
- Render success/error text.

Minimum save handler shape:

```tsx
const handleSaveProfile = async (event: React.FormEvent) => {
  event.preventDefault();
  setSaveError(null);
  const profileId = profile.id || crypto.randomUUID();
  const secretResult = secretAccessKey
    ? await settingsApi.saveS3Secret({
        profileId,
        secretAccessKey,
        allowInsecureFallback,
      })
    : { credentialRef: profile.credentialRef ?? `s3:${profileId}`, insecureFallbackUsed: profile.insecureSecretFallback };

  const savedProfile: S3Profile = {
    ...profile,
    id: profileId,
    credentialRef: secretResult.credentialRef,
    insecureSecretFallback: secretResult.insecureFallbackUsed,
    pathStyle,
  };
  const nextSettings = {
    ...settings,
    profiles: upsertProfile(settings.profiles, savedProfile),
    namingTemplate,
    defaultProfileId: savedProfile.id,
  };
  await settingsApi.saveSettings(nextSettings);
  onSettingsChange(nextSettings);
  setSecretAccessKey("");
  setSaveMessage("Profile saved.");
};
```

- [x] **Step 4: Load settings on app startup**

In `src/App.tsx`, call `settingsApi.loadSettings` on mount:

```tsx
useEffect(() => {
  let cancelled = false;
  settingsApi
    .loadSettings()
    .then((loaded) => {
      if (!cancelled) setSettings(loaded);
    })
    .catch((error) => {
      if (!cancelled) setSettingsError(error instanceof Error ? error.message : String(error));
    });
  return () => {
    cancelled = true;
  };
}, []);
```

Render `settingsError` in the workspace if present.

- [x] **Step 5: Verify and commit**

Run:

```bash
pnpm test -- src/features/settings/SettingsPage.test.tsx
pnpm test
pnpm build
```

Expected: settings save/load tests pass and build succeeds.

Commit:

```bash
git add src
git commit -m "feat: wire settings profile persistence"
```

## Task 4: Real File Import And Backend Image Inspection

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/api/tauri.ts`
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify: `src/features/optimize/OptimizePage.test.tsx`

- [x] **Step 1: Add Tauri dialog plugin**

Run:

```bash
pnpm add @tauri-apps/plugin-dialog@^2
cd src-tauri
cargo add tauri-plugin-dialog@2
cd ..
```

In `src-tauri/src/lib.rs`, register:

```rust
.plugin(tauri_plugin_dialog::init())
```

- [x] **Step 2: Write import test with mocked dialog and inspection**

In `OptimizePage.test.tsx`, mock dialog open and `tauriApi.inspectImage`:

```tsx
vi.mock("@tauri-apps/plugin-dialog", async () => ({
  open: vi.fn(async () => ["/tmp/real-photo.jpg"]),
}));

const inspectImage = vi.fn(async () => ({
  id: "real-photo",
  sourcePath: "/tmp/real-photo.jpg",
  fileName: "real-photo.jpg",
  sourceFormat: "jpg",
  originalBytes: 1_200_000,
  estimatedBytes: 260_000,
  status: "ready",
  settings: {
    targetFormat: "webp",
    quality: 68,
    maxWidth: 1600,
    maxHeight: 1600,
    allowUpscale: false,
    removeGps: true,
  },
}));

vi.mock("../../api/tauri", async () => ({
  tauriApi: {
    inspectImage,
  },
  uploadApi: {
    uploadObject: vi.fn(),
  },
}));
```

Add:

```tsx
it("imports selected image files through backend inspection", async () => {
  const user = userEvent.setup();
  render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

  await user.click(screen.getByRole("button", { name: /choose images/i }));

  expect(inspectImage).toHaveBeenCalledWith({
    path: "/tmp/real-photo.jpg",
    settings: expect.objectContaining({ targetFormat: "webp", quality: 68 }),
  });
  expect(await screen.findByText("real-photo.jpg")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Compress" })).toBeEnabled();
});
```

- [x] **Step 3: Implement Choose Images**

In `OptimizePage.tsx`:

- Import `open` from `@tauri-apps/plugin-dialog`.
- Add a `Choose images` button.
- Call `open({ multiple: true, filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "avif", "heif", "heic"] }] })`.
- Normalize the return value to an array of paths.
- For each path, call `tauriApi.inspectImage({ path, settings: currentPresetSettings })`.
- Convert `ImageInspection` to `OptimizeItem`.
- Show per-item errors instead of dropping failed files.

Do not keep a built-in sample image.

- [x] **Step 4: Verify and commit**

Run:

```bash
pnpm test -- src/features/optimize/OptimizePage.test.tsx
pnpm test
pnpm build
cd src-tauri
cargo check
cd ..
```

Expected: import test passes, frontend builds, Rust compiles.

Commit:

```bash
git add package.json pnpm-lock.yaml src src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs
git commit -m "feat: import real images for optimization"
```

## Task 5: Real Compression, Result Cache, And Save To Local Folder

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/optimizer.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/api/tauri.ts`
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify: `src/features/optimize/OptimizePage.test.tsx`

- [x] **Step 1: Add backend batch compression models**

Add to `src-tauri/src/models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompressBatchItem {
    pub id: String,
    pub source_path: String,
    pub output_file_name: String,
    pub settings: CompressionSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompressBatchRequest {
    pub items: Vec<CompressBatchItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompressBatchItemResult {
    pub id: String,
    pub result: Option<CompressImageResult>,
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompressBatchResponse {
    pub run_id: String,
    pub output_dir: String,
    pub items: Vec<CompressBatchItemResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopyOutputsRequest {
    pub output_paths: Vec<String>,
    pub target_dir: String,
}
```

If `AppError` cannot be referenced from `models.rs` without a cycle, create a serializable `ItemError { code, message, recoverable }` in `models.rs` and convert from `AppError`.

- [x] **Step 2: Add backend commands**

In `optimizer.rs`, implement:

- `compress_batch(paths: &AppPaths, request: CompressBatchRequest) -> AppResult<CompressBatchResponse>`
- `copy_outputs_to_dir(request: CopyOutputsRequest) -> AppResult<Vec<String>>`

Behavior:

- Create `paths.data_dir.join("optimizer-cache").join(run_id)`.
- Use existing `compress_image` per item.
- Catch per-item failures and continue.
- Copy saved outputs to target dir using original output filenames.

- [x] **Step 3: Register commands**

In `lib.rs`, register:

```rust
#[tauri::command]
fn compress_batch(
    paths: State<'_, AppPaths>,
    request: CompressBatchRequest,
) -> AppResult<CompressBatchResponse> {
    optimizer::compress_batch(&paths, request)
}

#[tauri::command]
fn copy_outputs_to_dir(request: CopyOutputsRequest) -> AppResult<Vec<String>> {
    optimizer::copy_outputs_to_dir(request)
}
```

- [x] **Step 4: Add frontend wrappers**

In `src/api/tauri.ts`:

```ts
export const tauriApi = {
  inspectImage: ...,
  compressBatch: (request: CompressBatchRequest) =>
    invoke<CompressBatchResponse>("compress_batch", { request }),
  copyOutputsToDir: (request: CopyOutputsRequest) =>
    invoke<string[]>("copy_outputs_to_dir", { request }),
};
```

Define matching TypeScript interfaces.

- [x] **Step 5: Write compression UI tests**

Mock `tauriApi.compressBatch` to return a real output path:

```tsx
const compressBatch = vi.fn(async () => ({
  runId: "run-1",
  outputDir: "/tmp/pic-piper/run-1",
  items: [
    {
      id: "real-photo",
      result: {
        sourcePath: "/tmp/real-photo.jpg",
        outputPath: "/tmp/pic-piper/run-1/real-photo.webp",
        outputFileName: "real-photo.webp",
        originalBytes: 1_200_000,
        outputBytes: 240_000,
        targetFormat: "webp",
      },
    },
  ],
}));
```

Assert:

```tsx
await user.click(screen.getByRole("button", { name: "Compress" }));
expect(compressBatch).toHaveBeenCalled();
expect(await screen.findByText("real-photo.webp")).toBeInTheDocument();
expect(screen.getByText(/1.2 MB => 240 KB/)).toBeInTheDocument();
```

Mock dialog directory selection and `copyOutputsToDir`, then assert `Save to local folder` calls it with compressed output paths.

- [x] **Step 6: Implement frontend compression and save**

`Compress` must:

- Set item statuses to `compressing`.
- Call `tauriApi.compressBatch`.
- Merge results by `id`.
- Show per-item success/error.
- Enter results mode only after backend response.

`Save to local folder` must:

- Open a directory picker.
- Call `tauriApi.copyOutputsToDir`.
- Show the saved count or error.

- [x] **Step 7: Verify and commit**

Run:

```bash
pnpm test -- src/features/optimize/OptimizePage.test.tsx
pnpm test
pnpm build
cd src-tauri
cargo test optimizer
cargo test
cargo fmt --check
cd ..
```

Expected: real compression path is tested and passes.

Commit:

```bash
git add src src-tauri/src
git commit -m "feat: compress real images and save outputs"
```

## Task 6: Real S3 Gallery List, Copy, View, Download, Delete

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/gallery.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/api/tauri.ts`
- Modify: `src/features/gallery/S3GalleryPage.tsx`
- Modify: `src/features/gallery/S3GalleryPage.test.tsx`

- [x] **Step 1: Add backend download model and command**

Add to `models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadObjectRequest {
    pub profile: S3Profile,
    pub key: String,
    pub output_path: String,
}
```

In `gallery.rs`, implement:

```rust
pub async fn download_object(request: DownloadObjectRequest, secret: String) -> AppResult<String> {
    let client = client_for(&request.profile, secret).await;
    let response = client
        .get_object()
        .bucket(&request.profile.bucket)
        .key(&request.key)
        .send()
        .await
        .map_err(|err| AppError::new("s3DownloadFailed", err.to_string()))?;
    let bytes = response
        .body
        .collect()
        .await
        .map_err(|err| AppError::new("s3DownloadReadFailed", err.to_string()))?
        .into_bytes();
    tokio::fs::write(&request.output_path, bytes)
        .await
        .map_err(|err| AppError::new("downloadWriteFailed", err.to_string()))?;
    Ok(request.output_path)
}
```

Register `download_gallery_object` in `lib.rs`.

- [x] **Step 2: Write Gallery tests around API calls**

Mock `galleryApi`:

```tsx
const listObjects = vi.fn(async () => [
  {
    key: "images/photo.webp",
    size: 240_000,
    publicUrl: "https://cdn.example.com/images/photo.webp",
    isImage: true,
  },
]);
const deleteObject = vi.fn(async () => {});
const downloadObject = vi.fn(async () => "/tmp/photo.webp");

vi.mock("../../api/tauri", async () => ({
  galleryApi: { listObjects, deleteObject, downloadObject },
}));
```

Tests:

```tsx
it("loads objects for the selected profile and prefix", async () => {
  render(<S3GalleryPage galleryFocus={{ prefix: "images", highlightedKeys: [] }} profiles={[profile]} />);

  expect(await screen.findByText("images/photo.webp")).toBeInTheDocument();
  expect(listObjects).toHaveBeenCalledWith({ profile, prefix: "images" });
});

it("deletes after confirmation and refreshes the prefix", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const user = userEvent.setup();
  render(<S3GalleryPage galleryFocus={{ prefix: "images", highlightedKeys: [] }} profiles={[profile]} />);

  await screen.findByText("images/photo.webp");
  await user.click(screen.getByRole("button", { name: /delete/i }));

  expect(deleteObject).toHaveBeenCalledWith({ profile, key: "images/photo.webp" });
  expect(listObjects).toHaveBeenCalledTimes(2);
});
```

- [x] **Step 3: Implement Gallery loading and actions**

`S3GalleryPage` must:

- Determine selected profile from `galleryFocus.profile ?? profiles[0]`.
- Keep controlled `prefix` initialized from `galleryFocus.prefix || selectedProfile.defaultPrefix`.
- Call `galleryApi.listObjects` when selected profile or prefix changes.
- Render loading/error/empty states.
- Filter current objects by search input.
- `Copy URL`: use `navigator.clipboard.writeText(object.publicUrl)` or show "Public Base URL missing".
- `View`: use `openUrl` from `@tauri-apps/plugin-opener` or `window.open` for public URL.
- `Download`: ask for target path or folder through dialog, then call `galleryApi.downloadObject`.
- `Delete`: `window.confirm`, call delete, refresh list.

Do not implement rename or move.

- [x] **Step 4: Verify and commit**

Run:

```bash
pnpm test -- src/features/gallery/S3GalleryPage.test.tsx
pnpm test
pnpm build
cd src-tauri
cargo test gallery
cargo test
cargo fmt --check
cd ..
```

Expected: Gallery has no sample data and calls real API wrappers.

Commit:

```bash
git add src src-tauri/src
git commit -m "feat: wire S3 gallery actions"
```

## Task 7: Real Upload To S3 From Compression Results And Gallery

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/gallery.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/api/tauri.ts`
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify: `src/features/gallery/S3GalleryPage.tsx`
- Modify: `src/features/optimize/OptimizePage.test.tsx`
- Modify: `src/features/gallery/S3GalleryPage.test.tsx`

- [x] **Step 1: Move object-key generation to backend**

Add a command that uses `naming::render_object_key` and a file content hash:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenerateObjectKeyRequest {
    pub source_path: String,
    pub output_file_name: String,
    pub prefix: String,
    pub naming_template: String,
    pub ext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenerateObjectKeyResponse {
    pub object_key: String,
}
```

The command must:

- Read file bytes.
- Hash with SHA-256.
- Render `{yyyy}/{mm}/{slug}-{hash}.{ext}`.
- Prefix the rendered key with selected prefix if the template does not already start with that prefix.
- Normalize slashes.

- [x] **Step 2: Add upload request fields for history**

Extend `UploadObjectRequest` with optional history fields:

```rust
pub source_filename: Option<String>,
pub output_filename: Option<String>,
pub original_bytes: Option<u64>,
pub target_format: Option<ImageFormat>,
```

In `upload_gallery_object`, after successful `gallery::upload_object`, call `history::append_history`.

- [x] **Step 3: Test Optimize upload calls real upload wrapper**

Mock `uploadApi.uploadObject` and `namingApi.generateObjectKey`.

Assert:

```tsx
await user.click(screen.getByRole("button", { name: "Upload to S3" }));

expect(generateObjectKey).toHaveBeenCalledWith(expect.objectContaining({
  sourcePath: "/tmp/pic-piper/run-1/real-photo.webp",
  prefix: "images/2026/06",
  namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
}));
expect(uploadObject).toHaveBeenCalledWith(expect.objectContaining({
  profile,
  sourcePath: "/tmp/pic-piper/run-1/real-photo.webp",
  objectKey: "images/2026/06/real-photo-abcdef12.webp",
  contentType: "image/webp",
}));
expect(onUploadedToS3).toHaveBeenCalledWith({
  profile,
  prefix: "images/2026/06",
  highlightedKeys: ["images/2026/06/real-photo-abcdef12.webp"],
});
```

- [x] **Step 4: Implement Optimize upload**

`Upload to S3` from results must:

- Require at least one successful compressed output.
- Require selected profile.
- Generate object keys for each output.
- Call upload for each output.
- Show per-item upload status.
- On complete success, open Gallery with `profile`, `prefix`, and highlighted keys.
- On partial failure, show failed items and keep user on results screen.

- [x] **Step 5: Implement Gallery local upload**

`Upload local images` in Gallery must:

- Open file picker.
- Generate object keys for selected files.
- Upload through `uploadApi.uploadObject`.
- Refresh current prefix.
- Highlight newly uploaded keys.

- [x] **Step 6: Verify and commit**

Run:

```bash
pnpm test -- src/features/optimize/OptimizePage.test.tsx src/features/gallery/S3GalleryPage.test.tsx
pnpm test
pnpm build
cd src-tauri
cargo test naming
cargo test history
cargo test gallery
cargo test
cargo fmt --check
cd ..
```

Expected: real upload path is tested from both Optimize results and Gallery.

Commit:

```bash
git add src src-tauri/src
git commit -m "feat: upload optimized and local images to S3"
```

## Task 8: UI Correction And Default Window Fit

**Files:**
- Modify: `src/App.css`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify: `src/features/gallery/S3GalleryPage.tsx`
- Modify: `src/features/settings/SettingsPage.tsx`

- [x] **Step 1: Remove fixed minimum page width**

In `src/App.css`, remove:

```css
body {
  min-width: 960px;
}
```

Use:

```css
body {
  margin: 0;
  min-height: 100vh;
}
```

- [x] **Step 2: Make shell responsive to 800x600**

Use:

```css
.app-shell {
  display: grid;
  grid-template-columns: minmax(160px, 220px) minmax(0, 1fr);
  min-height: 100vh;
}

@media (max-width: 760px) {
  .app-shell {
    grid-template-columns: 1fr;
  }

  .sidebar {
    padding: 14px;
  }

  .sidebar nav {
    display: flex;
    flex-wrap: wrap;
  }
}
```

- [x] **Step 3: Fix Settings layout**

Settings must not be a three-column grid with one oversized panel. Use:

```css
.settings-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: minmax(0, 1fr);
  max-width: 980px;
}

.profile-form {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

@media (max-width: 820px) {
  .profile-form {
    grid-template-columns: 1fr;
  }
}
```

- [x] **Step 4: Add disabled/loading/error visual states**

Add styles for:

```css
.status-line {}
.error-text {}
.success-text {}
button:disabled {}
.loading-panel {}
```

Every page must show specific status messages:

- Optimize: importing, compressing, saving, uploading.
- Gallery: loading prefix, deleting, downloading, uploading.
- Settings: saving profile, profile saved, credential fallback warning.

- [x] **Step 5: Manual visual verification**

Run:

```bash
pnpm dev --host 127.0.0.1
```

Open `http://127.0.0.1:1420/` and verify at 800x600:

- No horizontal overflow.
- Sidebar/navigation usable.
- Optimize empty state does not look like a broken drop zone.
- Settings form labels and inputs do not overlap.
- Gallery empty/loading/error states are clear.

Then run:

```bash
pnpm build
```

Commit:

```bash
git add src src-tauri/tauri.conf.json
git commit -m "fix: make Pic Piper UI usable at default window size"
```

## Task 9: End-To-End Acceptance Tests And Final Audit

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-06-26-pic-piper-corrective-implementation.md` checkbox status only

- [x] **Step 1: Add final static audit command**

Run:

```bash
rg -n "SAMPLE_ITEMS|SAMPLE_OBJECTS|/sample/photo-01|_props|static gallery|temporary sample" src
```

Expected: no matches.

- [x] **Step 2: Run full automated verification**

Run:

```bash
pnpm test
pnpm build
cd src-tauri
cargo test
cargo fmt --check
cd ..
```

Expected: all pass.

- [x] **Step 3: Run functional smoke test with a local image**

Create or use a small local PNG/JPG. In the app:

1. Open Optimize.
2. Choose the image.
3. Confirm real filename, size, and dimensions appear.
4. Adjust quality.
5. Click Compress.
6. Confirm output path and output size appear.
7. Click Save to local folder.
8. Confirm the output file exists in the chosen folder.

- [x] **Step 4: Run S3 smoke test**

Use MinIO or a real low-risk S3-compatible bucket:

1. Save profile in Settings.
2. Open S3 Gallery.
3. List a prefix.
4. Upload a small local image.
5. Copy URL.
6. Delete the object.
7. Refresh prefix and confirm it is gone.

If no S3 endpoint is available, document that only S3 smoke was skipped. Do not claim S3 is verified.

- [x] **Step 5: Update README truthfully**

README must state exactly what works and how to run it. Include:

- How to configure S3 profile.
- How to choose images and compress.
- How to upload to S3.
- Known v1 limits: no auto-upload, no upload queue, no rename/move, no presigned URLs.

- [x] **Step 6: Commit final docs**

Commit:

```bash
git add README.md docs/superpowers/plans/2026-06-26-pic-piper-corrective-implementation.md
git commit -m "docs: document corrected Pic Piper MVP"
```

## Handoff Prompt For The Other Agent

Paste this into the other agent:

```text
You are taking over Pic Piper corrective implementation.

Read these first:
- docs/superpowers/specs/2026-06-26-pic-piper-design.md
- docs/superpowers/plans/2026-06-26-pic-piper-corrective-implementation.md

The previous implementation is incomplete even though the old checklist is fully checked. Do not trust the old completed plan. The current app has backend commands but the frontend mostly renders sample data and static buttons.

Use superpowers:executing-plans or superpowers:subagent-driven-development. Execute the corrective plan task-by-task.

Hard rules:
- No SAMPLE_ITEMS or SAMPLE_OBJECTS in user-visible pages.
- No sample path such as /sample/photo-01.jpg.
- No auto-upload.
- No standalone upload queue.
- No S3 rename or move.
- Settings must save profile data and credentials.
- Optimize must import real files, inspect them through Tauri, compress them through Tauri, and save real outputs.
- S3 Gallery must list real S3 objects and call backend APIs for upload/download/delete.
- Tests must assert real API wrappers are called. Button-presence tests alone are not enough.

After each task:
1. Run the exact verification commands in the task.
2. Fix failures before continuing.
3. Commit with the specified commit message.
4. Update checkboxes only for steps actually completed and verified.

Final acceptance requires:
- pnpm test
- pnpm build
- cd src-tauri && cargo test && cargo fmt --check
- static audit with rg showing no sample UI constants
- manual Optimize smoke with a real local image
- S3 smoke with MinIO or a real test bucket, or an explicit note that S3 smoke was not run
```

## Self-Review

Spec coverage:

- Settings persistence and credential storage: Task 3.
- Real image import and inspection: Task 4.
- Real compression and save-to-folder: Task 5.
- Real S3 list/copy/view/download/delete: Task 6.
- Real Optimize-to-S3 upload and Gallery highlight: Task 7.
- UI default-window fixes: Task 8.
- Verification that mocks are gone: Tasks 1 and 9.

Known risk:

- Exact Tauri dialog/download APIs may require small syntax adjustments depending on installed plugin versions. The required behavior is fixed: file/directory selection must be real, not simulated in production code.
