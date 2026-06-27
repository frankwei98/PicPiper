# Optimize Task Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace preset/manual batch compression with automatic per-image compression tasks, bounded concurrency, per-card format selection, cancellation, retry, and compare previews.

**Architecture:** Remove presets from the settings schema first, then introduce focused optimize queue helpers for format defaults, output naming, concurrency, and item state transitions. Refactor `OptimizePage` to use those helpers and a bounded frontend scheduler that calls `compressImage` per item, while keeping the existing Rust `compress_image` execution primitive.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, Tauri v2, Rust, serde, existing Base UI `Dialog` and `Slider` components.

---

## Working Notes

- Repository root: `/Users/frankwei/Code/DesktopApp/pic-piper`
- Confirmed design: `/Users/frankwei/Code/DesktopApp/pic-piper/docs/superpowers/specs/2026-06-27-optimize-task-queue-design.md`
- There is an existing unrelated local modification in `/Users/frankwei/Code/DesktopApp/pic-piper/src/components/ui/Slider.tsx`. Do not revert it.
- Use `PIC_PIPER_NO_KEYCHAIN=1` for local commands that may touch settings or Tauri tests.
- Prefer small commits after each task.

## File Structure

Modify:

- `/Users/frankwei/Code/DesktopApp/pic-piper/src/types.ts`: remove `CompressionPreset`, update `ImageStatus`, keep shared item/settings types.
- `/Users/frankwei/Code/DesktopApp/pic-piper/src/api/tauri.ts`: remove preset from `AppSettings`; keep `compressImage`; keep or leave `compressBatch` until no frontend references remain.
- `/Users/frankwei/Code/DesktopApp/pic-piper/src/App.tsx`: stop initializing and passing presets.
- `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/settings/SettingsPage.tsx`: delete preset UI and logic.
- `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/settings/SettingsPage.test.tsx`: remove preset tests and assert preset UI is absent.
- `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/optimize/OptimizePage.tsx`: refactor to automatic task queue UI.
- `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/optimize/OptimizePage.test.tsx`: rewrite around automatic per-item compression.
- `/Users/frankwei/Code/DesktopApp/pic-piper/src-tauri/src/models.rs`: remove `CompressionPreset` and `AppSettings.presets`.
- `/Users/frankwei/Code/DesktopApp/pic-piper/src-tauri/src/lib.rs`: add an optimizer run directory command for single-image compression outputs.
- `/Users/frankwei/Code/DesktopApp/pic-piper/src-tauri/src/settings.rs`: update default settings test.

Create:

- `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/optimize/optimizeQueue.ts`: pure helpers for statuses, format defaults, concurrency, output filenames, byte formatting, and item patching.
- `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/optimize/optimizeQueue.test.ts`: unit tests for the helper behavior.

Do not create a shadcn dependency in this implementation. The confirmed spec keeps the existing Base UI components.

---

### Task 1: Remove Presets From Settings Schema And Settings UI

**Files:**

- Modify: `/Users/frankwei/Code/DesktopApp/pic-piper/src/types.ts`
- Modify: `/Users/frankwei/Code/DesktopApp/pic-piper/src/api/tauri.ts`
- Modify: `/Users/frankwei/Code/DesktopApp/pic-piper/src/App.tsx`
- Modify: `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/settings/SettingsPage.tsx`
- Modify: `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/settings/SettingsPage.test.tsx`
- Modify: `/Users/frankwei/Code/DesktopApp/pic-piper/src-tauri/src/models.rs`
- Modify: `/Users/frankwei/Code/DesktopApp/pic-piper/src-tauri/src/settings.rs`

- [ ] **Step 1: Write failing settings tests**

In `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/settings/SettingsPage.test.tsx`, remove the preset CRUD tests and add this test near the profile tests:

```tsx
it("does not render preset management", () => {
  render(
    <SettingsPage
      settings={{
        profiles: [],
        namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
      }}
      onSettingsChange={() => {}}
    />,
  );

  expect(screen.queryByText(/presets/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /add preset/i })).not.toBeInTheDocument();
});
```

Update every `settings={{ ... }}` object in this file by deleting `presets: []` or `presets: [...]`. Update save assertions so they no longer expect `presets`.

- [ ] **Step 2: Run frontend settings test and verify failure**

Run:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test -- src/features/settings/SettingsPage.test.tsx
```

Expected: FAIL because `SettingsPage` still renders preset management and the TypeScript `AppSettings` type still requires `presets`.

- [ ] **Step 3: Remove preset types from TypeScript settings**

In `/Users/frankwei/Code/DesktopApp/pic-piper/src/types.ts`, delete the `CompressionPreset` interface.

In `/Users/frankwei/Code/DesktopApp/pic-piper/src/api/tauri.ts`, change the import and `AppSettings` interface to:

```ts
import type { CompressionSettings, GalleryObject, OptimizeItem, S3Profile } from "../types";

export interface AppSettings {
  profiles: S3Profile[];
  namingTemplate: string;
  defaultOutputDir?: string;
  defaultProfileId?: string;
}
```

In `/Users/frankwei/Code/DesktopApp/pic-piper/src/App.tsx`, initialize settings without presets and stop passing presets:

```tsx
const [settings, setSettings] = useState<AppSettings>({
  profiles: [],
  namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
});
```

Render `OptimizePage` like this:

```tsx
<OptimizePage
  activeProfile={selectedProfile}
  namingTemplate={settings.namingTemplate}
  onUploadedToS3={openGallery}
/>
```

- [ ] **Step 4: Remove preset UI and state from SettingsPage**

In `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/settings/SettingsPage.tsx`:

Remove these imports:

```ts
import type { CompressionPreset, ImageFormat, S3Profile } from "../../types";
import { AlertDialog, Dialog } from "../../components/ui/Dialog";
```

Replace them with:

```ts
import type { S3Profile } from "../../types";
```

Remove `EMPTY_PRESET`, `btnDanger`, `editingPreset`, `isAddingPreset`, `presetForm`, `deleteTarget`, `isPresetDialogOpen`, `closePresetDialog`, `openAddPreset`, `openEditPreset`, `handleSavePreset`, `handleDeletePresetRequest`, and `handleDeletePresetConfirm`.

Change the header copy to:

```tsx
<p className="text-on-surface-variant mt-xs text-body text-pretty">Manage S3 profiles, naming, and output defaults.</p>
```

Delete the entire Presets `<article>` and the preset `Dialog` and `AlertDialog` at the bottom of the component. Leave the Profile article intact.

- [ ] **Step 5: Remove preset schema from Rust**

In `/Users/frankwei/Code/DesktopApp/pic-piper/src-tauri/src/models.rs`, delete the `CompressionPreset` struct and remove `pub presets: Vec<CompressionPreset>,` from `AppSettings`.

Update `impl Default for AppSettings` to:

```rust
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            profiles: Vec::new(),
            naming_template: "{yyyy}/{mm}/{slug}-{hash}.{ext}".to_string(),
            default_output_dir: None,
            default_profile_id: None,
        }
    }
}
```

In `/Users/frankwei/Code/DesktopApp/pic-piper/src-tauri/src/settings.rs`, update the test:

```rust
#[test]
fn missing_settings_returns_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let settings = load_settings(&dir.path().join("settings.json")).unwrap();
    assert_eq!(settings.naming_template, "{yyyy}/{mm}/{slug}-{hash}.{ext}");
    assert!(settings.profiles.is_empty());
    assert!(settings.default_output_dir.is_none());
    assert!(settings.default_profile_id.is_none());
}
```

- [ ] **Step 6: Run tests for Task 1**

Run:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test -- src/features/settings/SettingsPage.test.tsx
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test settings::tests::missing_settings_returns_defaults
```

Expected: both pass.

- [ ] **Step 7: Commit Task 1**

Run:

```bash
git add src/types.ts src/api/tauri.ts src/App.tsx src/features/settings/SettingsPage.tsx src/features/settings/SettingsPage.test.tsx src-tauri/src/models.rs src-tauri/src/settings.rs
git commit -m "feat: remove compression presets"
```

---

### Task 2: Add Optimize Queue Pure Helpers

**Files:**

- Create: `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/optimize/optimizeQueue.ts`
- Create: `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/optimize/optimizeQueue.test.ts`
- Modify: `/Users/frankwei/Code/DesktopApp/pic-piper/src/types.ts`

- [ ] **Step 1: Update shared status type**

In `/Users/frankwei/Code/DesktopApp/pic-piper/src/types.ts`, replace `ImageStatus` with:

```ts
export type ImageStatus =
  | "inspecting"
  | "queued"
  | "compressing"
  | "loadingPreview"
  | "compressed"
  | "failed"
  | "cancelled";
```

Add optional preview/task fields to `OptimizeItem`:

```ts
  originalPreviewUrl?: string;
  compressedPreviewUrl?: string;
  taskVersion?: number;
  cancelling?: boolean;
```

- [ ] **Step 2: Write helper tests**

Create `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/optimize/optimizeQueue.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AVAILABLE_OUTPUT_FORMATS,
  defaultTargetFormat,
  formatBytes,
  getCompressionConcurrency,
  makeOutputFileName,
  makeUniqueOutputFileNames,
  shouldRequeueForGlobalSettings,
} from "./optimizeQueue";
import type { OptimizeItem } from "../../types";

function item(status: OptimizeItem["status"]): OptimizeItem {
  return {
    id: status,
    sourcePath: `/tmp/${status}.jpg`,
    fileName: `${status}.jpg`,
    sourceFormat: "jpg",
    originalBytes: 1000,
    status,
    settings: {
      targetFormat: "jpg",
      quality: 85,
      removeGps: true,
    },
  };
}

describe("optimizeQueue", () => {
  it("defaults target format to source format except HEIF uses WebP", () => {
    expect(defaultTargetFormat("jpg")).toBe("jpg");
    expect(defaultTargetFormat("png")).toBe("png");
    expect(defaultTargetFormat("webp")).toBe("webp");
    expect(defaultTargetFormat("avif")).toBe("avif");
    expect(defaultTargetFormat("heif")).toBe("webp");
    expect(defaultTargetFormat("unknown")).toBe("webp");
  });

  it("does not offer HEIF output", () => {
    expect(AVAILABLE_OUTPUT_FORMATS).toEqual(["jpg", "png", "webp", "avif"]);
  });

  it("computes concurrency as cores minus one with a minimum of one", () => {
    expect(getCompressionConcurrency(10)).toBe(9);
    expect(getCompressionConcurrency(2)).toBe(1);
    expect(getCompressionConcurrency(1)).toBe(1);
    expect(getCompressionConcurrency(undefined)).toBe(3);
  });

  it("derives output filename from current target format", () => {
    expect(makeOutputFileName("photo.large.jpg", "webp")).toBe("photo.large.webp");
    expect(makeOutputFileName("photo", "jpg")).toBe("photo.jpg");
  });

  it("disambiguates duplicate output filenames", () => {
    expect(
      makeUniqueOutputFileNames([
        { id: "a", fileName: "photo.jpg", targetFormat: "webp" },
        { id: "b", fileName: "photo.png", targetFormat: "webp" },
        { id: "c", fileName: "photo.jpg", targetFormat: "jpg" },
      ]),
    ).toEqual({
      a: "photo.webp",
      b: "photo-2.webp",
      c: "photo.jpg",
    });
  });

  it("requeues only active items for global setting changes", () => {
    expect(shouldRequeueForGlobalSettings(item("compressed"))).toBe(true);
    expect(shouldRequeueForGlobalSettings(item("queued"))).toBe(true);
    expect(shouldRequeueForGlobalSettings(item("compressing"))).toBe(true);
    expect(shouldRequeueForGlobalSettings(item("failed"))).toBe(false);
    expect(shouldRequeueForGlobalSettings(item("cancelled"))).toBe(false);
  });

  it("formats bytes for UI", () => {
    expect(formatBytes(1_200_000)).toBe("1.2 MB");
    expect(formatBytes(240_000)).toBe("240 KB");
    expect(formatBytes(0)).toBe("0 KB");
  });
});
```

- [ ] **Step 3: Run helper tests and verify failure**

Run:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test -- src/features/optimize/optimizeQueue.test.ts
```

Expected: FAIL because `optimizeQueue.ts` does not exist.

- [ ] **Step 4: Implement optimizeQueue helpers**

Create `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/optimize/optimizeQueue.ts`:

```ts
import type { ImageFormat, OptimizeItem } from "../../types";

export const AVAILABLE_OUTPUT_FORMATS = ["jpg", "png", "webp", "avif"] as const satisfies ReadonlyArray<ImageFormat>;

export type AvailableOutputFormat = (typeof AVAILABLE_OUTPUT_FORMATS)[number];

export function defaultTargetFormat(sourceFormat: OptimizeItem["sourceFormat"]): ImageFormat {
  if (sourceFormat === "jpg" || sourceFormat === "png" || sourceFormat === "webp" || sourceFormat === "avif") {
    return sourceFormat;
  }
  return "webp";
}

export function getCompressionConcurrency(hardwareConcurrency: number | undefined): number {
  return Math.max(1, (hardwareConcurrency ?? 4) - 1);
}

export function makeOutputFileName(fileName: string, targetFormat: ImageFormat): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  const stem = base || fileName || "image";
  return `${stem}.${targetFormat}`;
}

export function makeUniqueOutputFileNames(
  items: Array<{ id: string; fileName: string; targetFormat: ImageFormat }>,
): Record<string, string> {
  const seen = new Map<string, number>();
  const outputNames: Record<string, string> = {};

  for (const item of items) {
    const preferredName = makeOutputFileName(item.fileName, item.targetFormat);
    const count = (seen.get(preferredName) ?? 0) + 1;
    seen.set(preferredName, count);
    outputNames[item.id] = count === 1 ? preferredName : appendSuffix(preferredName, count);
  }

  return outputNames;
}

function appendSuffix(fileName: string, suffix: number): string {
  const match = /^(.*)\.([^.]+)$/.exec(fileName);
  if (!match) return `${fileName}-${suffix}`;
  return `${match[1]}-${suffix}.${match[2]}`;
}

export function shouldRequeueForGlobalSettings(item: OptimizeItem): boolean {
  return item.status !== "failed" && item.status !== "cancelled";
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}

export function savingsPercent(originalBytes: number, outputBytes: number): number {
  if (originalBytes <= 0) return 0;
  return Math.max(0, Math.round((1 - outputBytes / originalBytes) * 100));
}
```

- [ ] **Step 5: Run helper tests and typecheck**

Run:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test -- src/features/optimize/optimizeQueue.test.ts
PIC_PIPER_NO_KEYCHAIN=1 pnpm build
```

Expected: helper tests pass. `pnpm build` may fail from existing OptimizePage references to old statuses; continue to Task 3 if that is the only failure class.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add src/types.ts src/features/optimize/optimizeQueue.ts src/features/optimize/optimizeQueue.test.ts
git commit -m "feat: add optimize queue helpers"
```

---

### Task 3: Add Optimizer Run Directory API

**Files:**

- Modify: `/Users/frankwei/Code/DesktopApp/pic-piper/src/api/tauri.ts`
- Modify: `/Users/frankwei/Code/DesktopApp/pic-piper/src-tauri/src/lib.rs`
- Modify: `/Users/frankwei/Code/DesktopApp/pic-piper/src-tauri/src/models.rs`

- [ ] **Step 1: Add Rust model for cache dir response**

In `/Users/frankwei/Code/DesktopApp/pic-piper/src-tauri/src/models.rs`, add this model near the compression request/response models:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateOptimizerRunResponse {
    pub run_id: String,
    pub output_dir: String,
}
```

- [ ] **Step 2: Add Tauri command**

In `/Users/frankwei/Code/DesktopApp/pic-piper/src-tauri/src/lib.rs`, include `CreateOptimizerRunResponse` in the `use models::{ ... }` list.

Add this command before `compress_image`:

```rust
#[tauri::command]
fn create_optimizer_run(paths: State<'_, AppPaths>) -> AppResult<CreateOptimizerRunResponse> {
    let run_id = format!(
        "run-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    );
    let output_dir = paths.data_dir.join("optimizer-cache").join(&run_id);
    std::fs::create_dir_all(&output_dir)
        .map_err(|err| error::AppError::new("outputDirFailed", err.to_string()))?;
    Ok(CreateOptimizerRunResponse {
        run_id,
        output_dir: output_dir.to_string_lossy().to_string(),
    })
}
```

Add `create_optimizer_run` to `tauri::generate_handler![...]`.

- [ ] **Step 3: Add frontend API wrapper**

In `/Users/frankwei/Code/DesktopApp/pic-piper/src/api/tauri.ts`, add:

```ts
export interface CreateOptimizerRunResponse {
  runId: string;
  outputDir: string;
}
```

Add this method to `tauriApi`:

```ts
createOptimizerRun: () =>
  invoke<CreateOptimizerRunResponse>("create_optimizer_run"),
```

- [ ] **Step 4: Run Task 3 checks**

Run:

```bash
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test
```

Expected: Rust tests pass. Frontend build may still fail until Task 4 because `OptimizePage` still uses the old status values and manual batch flow.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add src/api/tauri.ts src-tauri/src/lib.rs src-tauri/src/models.rs
git commit -m "feat: allocate optimizer run directories"
```

---

### Task 4: Refactor OptimizePage To Automatic Per-Item Tasks

**Files:**

- Modify: `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/optimize/OptimizePage.tsx`
- Modify: `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/optimize/OptimizePage.test.tsx`

- [ ] **Step 1: Replace OptimizePage tests with automatic queue coverage**

In `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/optimize/OptimizePage.test.tsx`, update the Tauri mock so `createOptimizerRun` and `compressImage` exist and `compressBatch` is not required for the page tests:

```ts
const { createOptimizerRun, inspectImage, compressImage, copyOutputsToDir, readThumbnail, mockDialogOpen, mockOnDragDropEvent, uploadObject, generateObjectKey } = vi.hoisted(() => {
  const mockDialogOpen = vi.fn(async (..._args: unknown[]) => ["/tmp/real-photo.jpg"]);
  return {
    createOptimizerRun: vi.fn(async () => ({
      runId: "run-1",
      outputDir: "/tmp/pic-piper/run-1",
    })),
    inspectImage: vi.fn(async () => ({
      id: "real-photo",
      sourcePath: "/tmp/real-photo.jpg",
      fileName: "real-photo.jpg",
      sourceFormat: "jpg",
      originalBytes: 1_200_000,
      estimatedBytes: 260_000,
      status: "queued",
      settings: {
        targetFormat: "jpg",
        quality: 85,
        removeGps: true,
      },
    })),
    compressImage: vi.fn(async () => ({
      sourcePath: "/tmp/real-photo.jpg",
      outputPath: "/tmp/pic-piper/run-1/real-photo.jpg",
      outputFileName: "real-photo.jpg",
      originalBytes: 1_200_000,
      outputBytes: 240_000,
      targetFormat: "jpg",
    })),
    copyOutputsToDir: vi.fn(async () => ["/tmp/saved/real-photo.jpg"]),
    readThumbnail: vi.fn(async ({ path }: { path: string }) => ({
      dataUrl: path.includes("pic-piper") ? "data:image/jpeg;base64,COMPRESSED" : "data:image/jpeg;base64,ORIGINAL",
    })),
    mockDialogOpen,
    mockOnDragDropEvent: vi.fn(async () => vi.fn()),
    uploadObject: vi.fn(async () => ({
      key: "images/2026/06/real-photo-abcdef12.jpg",
      size: 240_000,
      publicUrl: "https://cdn.example.com/images/2026/06/real-photo-abcdef12.jpg",
      isImage: true,
    })),
    generateObjectKey: vi.fn(async () => ({
      objectKey: "images/2026/06/real-photo-abcdef12.jpg",
    })),
  };
});
```

Update the API mock:

```ts
vi.mock("../../api/tauri", async () => ({
  tauriApi: {
    createOptimizerRun,
    inspectImage,
    compressImage,
    copyOutputsToDir,
    readThumbnail,
  },
  uploadApi: {
    uploadObject,
  },
  namingApi: {
    generateObjectKey,
  },
}));
```

Replace old preset/manual compress tests with these behaviors:

```tsx
it("does not render preset controls or a manual Compress button", () => {
  render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

  expect(screen.queryByLabelText(/preset/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^compress$/i })).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /remove gps/i })).toBeChecked();
  expect(screen.getByRole("slider", { name: /quality/i })).toBeInTheDocument();
});

it("imports selected images and starts single-image compression automatically", async () => {
  const user = userEvent.setup();
  render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

  await user.click(screen.getByRole("button", { name: /choose images/i }));

  expect(inspectImage).toHaveBeenCalledWith({
    path: "/tmp/real-photo.jpg",
    settings: expect.objectContaining({ targetFormat: "webp", quality: 85, removeGps: true }),
  });
  expect(await screen.findByText("real-photo.jpg")).toBeInTheDocument();
  expect(compressImage).toHaveBeenCalledWith(
    expect.objectContaining({
      sourcePath: "/tmp/real-photo.jpg",
      outputFileName: "real-photo.jpg",
      settings: expect.objectContaining({ targetFormat: "jpg", quality: 85, removeGps: true }),
    }),
  );
  expect(await screen.findByText(/1.2 MB.*240 KB/)).toBeInTheDocument();
});

it("opens a comparison dialog from a compressed preview", async () => {
  const user = userEvent.setup();
  render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

  await user.click(screen.getByRole("button", { name: /choose images/i }));
  const previewButton = await screen.findByRole("button", { name: /compare real-photo\.jpg/i });
  await user.click(previewButton);

  expect(screen.getByRole("dialog", { name: /compare real-photo\.jpg/i })).toBeInTheDocument();
  expect(screen.getByText(/original/i)).toBeInTheDocument();
  expect(screen.getByText(/compressed/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run OptimizePage tests and verify failure**

Run:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test -- src/features/optimize/OptimizePage.test.tsx
```

Expected: FAIL because `OptimizePage` still uses presets, manual `Compress`, and `compressBatch`.

- [ ] **Step 3: Replace OptimizePage props and state**

In `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/optimize/OptimizePage.tsx`:

Remove `CompressionPreset` from imports and props. Import the helpers and `Dialog`:

```ts
import type { CompressionSettings, ImageFormat, OptimizeItem, S3Profile } from "../../types";
import { Dialog } from "../../components/ui/Dialog";
import {
  AVAILABLE_OUTPUT_FORMATS,
  defaultTargetFormat,
  formatBytes,
  getCompressionConcurrency,
  makeUniqueOutputFileNames,
  savingsPercent,
  shouldRequeueForGlobalSettings,
} from "./optimizeQueue";
```

Use this default settings object for inspect requests and global policy:

```ts
const DEFAULT_SETTINGS: CompressionSettings = {
  targetFormat: "webp",
  quality: 85,
  removeGps: true,
};
```

Change the component signature:

```tsx
export function OptimizePage({ activeProfile, namingTemplate, onUploadedToS3 }: OptimizePageProps) {
```

Add state:

```ts
const [items, setItems] = useState<OptimizeItem[]>([]);
const [quality, setQuality] = useState(DEFAULT_SETTINGS.quality);
const [removeGps, setRemoveGps] = useState(DEFAULT_SETTINGS.removeGps);
const [compareItemId, setCompareItemId] = useState<string | null>(null);
const activeTasks = useRef(new Set<string>());
const optimizerRun = useRef<{ runId: string; outputDir: string } | null>(null);
const debounceRef = useRef<number | undefined>();
```

Remove `mode`, `compressing`, `selectedPresetId`, `handleApplyPreset`, `handleCompress`, and all results-mode rendering.

- [ ] **Step 4: Implement import-to-inspect-to-queue flow**

In `importImages`, immediately append placeholder items:

```ts
const pendingItems: OptimizeItem[] = paths.map((path) => ({
  id: crypto.randomUUID(),
  sourcePath: path,
  fileName: path.split("/").pop() ?? "unknown",
  sourceFormat: "unknown",
  originalBytes: 0,
  status: "inspecting",
  settings: { ...DEFAULT_SETTINGS, quality, removeGps },
  taskVersion: 0,
}));

setItems((current) => [...current, ...pendingItems]);
```

For each pending item, call `tauriApi.inspectImage({ path, settings: { ...DEFAULT_SETTINGS, quality, removeGps } })`. On success, compute the item target format from the inspected source format:

```ts
const sourceFormat = ((raw.sourceFormat as OptimizeItem["sourceFormat"]) ?? (raw.source_format as OptimizeItem["sourceFormat"]) ?? "unknown");
const targetFormat = defaultTargetFormat(sourceFormat);
```

Patch the item to:

```ts
{
  fileName,
  sourceFormat,
  originalBytes,
  estimatedBytes,
  warning,
  status: "queued",
  settings: { targetFormat, quality, removeGps },
}
```

Then load the original preview with `readThumbnail({ path, maxSize: 512 })` and store `originalPreviewUrl`. If inspect fails, set `status: "failed"` and `error`.

- [ ] **Step 5: Implement bounded scheduler effect**

Add an effect that watches `items`, `quality`, and `removeGps`:

```ts
useEffect(() => {
  const concurrency = getCompressionConcurrency(navigator.hardwareConcurrency);
  const availableSlots = concurrency - activeTasks.current.size;
  if (availableSlots <= 0) return;

  const outputNames = makeUniqueOutputFileNames(
    items
      .filter((item) => item.status === "queued")
      .map((item) => ({
        id: item.id,
        fileName: item.fileName,
        targetFormat: item.settings.targetFormat,
      })),
  );

  const nextItems = items.filter((item) => item.status === "queued").slice(0, availableSlots);
  for (const item of nextItems) {
    activeTasks.current.add(item.id);
    void runCompressionTask(item, outputNames[item.id]);
  }
}, [items, quality, removeGps]);
```

Implement `runCompressionTask(item, outputFileName)` as a `useCallback` that:

1. Captures `item.id` and `item.taskVersion ?? 0`.
2. Sets item status to `compressing`.
3. Gets the run output directory:

```ts
const getOutputDir = async () => {
  if (!optimizerRun.current) {
    optimizerRun.current = await tauriApi.createOptimizerRun();
  }
  return optimizerRun.current.outputDir;
};

const outputDir = await getOutputDir();
```

4. Calls `tauriApi.compressImage` with:

```ts
{
  sourcePath: item.sourcePath,
  outputDir,
  outputFileName,
  settings: item.settings,
}
```

5. On success, ignore the result if the current item is cancelled or has a different `taskVersion`.
6. Set status to `loadingPreview` with output fields.
7. Call `readThumbnail({ path: result.outputPath, maxSize: 512 })`.
8. Set status to `compressed` and `compressedPreviewUrl` if still current.
9. On compression error, set item `failed`.
10. In `finally`, delete the item id from `activeTasks.current`.

- [ ] **Step 6: Implement global settings requeue with debounce**

Add handlers:

```ts
const scheduleGlobalRequeue = (nextQuality: number, nextRemoveGps: boolean) => {
  window.clearTimeout(debounceRef.current);
  debounceRef.current = window.setTimeout(() => {
    setItems((current) =>
      current.map((item) =>
        shouldRequeueForGlobalSettings(item)
          ? {
              ...item,
              status: "queued",
              outputBytes: undefined,
              outputPath: undefined,
              outputFileName: undefined,
              compressedPreviewUrl: undefined,
              error: undefined,
              cancelling: false,
              taskVersion: (item.taskVersion ?? 0) + 1,
              settings: {
                ...item.settings,
                quality: nextQuality,
                removeGps: nextRemoveGps,
              },
            }
          : item,
      ),
    );
  }, 400);
};

const handleQualityChange = (nextQuality: number) => {
  setQuality(nextQuality);
  scheduleGlobalRequeue(nextQuality, removeGps);
};

const handleRemoveGpsChange = (checked: boolean) => {
  setRemoveGps(checked);
  scheduleGlobalRequeue(quality, checked);
};
```

Clear the timeout in component cleanup.

- [ ] **Step 7: Implement format change, cancel, retry, remove**

Implement:

```ts
const updateFormat = (id: string, targetFormat: ImageFormat) => {
  setItems((current) =>
    current.map((item) =>
      item.id === id && item.status !== "cancelled"
        ? {
            ...item,
            status: "queued",
            outputBytes: undefined,
            outputPath: undefined,
            outputFileName: undefined,
            compressedPreviewUrl: undefined,
            error: undefined,
            taskVersion: (item.taskVersion ?? 0) + 1,
            settings: { ...item.settings, targetFormat, quality, removeGps },
          }
        : item,
    ),
  );
};

const cancelItem = (id: string) => {
  setItems((current) =>
    current.map((item) =>
      item.id === id
        ? {
            ...item,
            status: "cancelled",
            cancelling: item.status === "compressing",
            taskVersion: (item.taskVersion ?? 0) + 1,
          }
        : item,
    ),
  );
};

const retryItem = (id: string) => {
  setItems((current) =>
    current.map((item) =>
      item.id === id
        ? {
            ...item,
            status: item.originalBytes > 0 ? "queued" : "inspecting",
            error: undefined,
            cancelling: false,
            taskVersion: (item.taskVersion ?? 0) + 1,
            settings: { ...item.settings, quality, removeGps },
          }
        : item,
    ),
  );
};
```

Keep `removeItem`. If previews are stored directly on `OptimizeItem`, removing the item is enough. If the implementation keeps any separate preview map, remove `id` from that map in the same callback that removes the item.

- [ ] **Step 8: Replace OptimizePage render**

Render a single page with:

```tsx
<header className="flex justify-between items-start gap-lg">
  <div>
    <h2 className="text-large-title font-bold text-on-surface text-balance">Optimize</h2>
    <p className="text-on-surface-variant mt-xs text-body text-pretty">Drop images to compress automatically.</p>
  </div>
  <div className="flex gap-md items-end flex-wrap">
    <label className="flex items-center gap-sm text-footnote font-medium text-on-surface-variant">
      <input type="checkbox" checked={removeGps} onChange={(e) => handleRemoveGpsChange(e.target.checked)} />
      Remove GPS
    </label>
    <label className="grid gap-xs min-w-[220px] text-footnote font-medium text-on-surface-variant">
      Quality {quality}%
      <Slider aria-label="Quality" value={quality} onValueChange={handleQualityChange} min={1} max={100} />
    </label>
  </div>
</header>
```

For each item card, include:

- A preview area.
- A format select when inspect has succeeded:

```tsx
<select
  aria-label={`Format for ${item.fileName}`}
  value={item.settings.targetFormat}
  onChange={(event) => updateFormat(item.id, event.target.value as ImageFormat)}
  disabled={item.status === "inspecting" || item.status === "cancelled"}
>
  {AVAILABLE_OUTPUT_FORMATS.map((format) => (
    <option key={format} value={format}>
      {format.toUpperCase()}
    </option>
  ))}
</select>
```

- Cancel button for `inspecting`, `queued`, `compressing`, `loadingPreview`.
- Retry button for `failed` and `cancelled`.
- Remove button for all terminal states.
- Compare preview button when `item.status === "compressed"`:

```tsx
<button type="button" aria-label={`Compare ${item.fileName}`} onClick={() => setCompareItemId(item.id)}>
  <img src={item.compressedPreviewUrl} alt="" loading="lazy" className="w-full h-full object-cover block" />
</button>
```

Add a `Dialog` for `compareItemId`, with Original and Compressed columns and metadata.

- [ ] **Step 9: Update save and upload to use compressed items in single-page mode**

Keep `handleSaveToLocal` and `uploadToS3`, but remove references to results mode. They should filter:

```ts
const compressedItems = items.filter((item) => item.status === "compressed" && item.outputPath);
```

Use `item.outputFileName`, `item.settings.targetFormat`, `item.outputPath`, `item.originalBytes`, and `item.outputBytes`.

- [ ] **Step 10: Run OptimizePage tests**

Run:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test -- src/features/optimize/OptimizePage.test.tsx
```

Expected: PASS after implementation.

- [ ] **Step 11: Commit Task 4**

Run:

```bash
git add src/features/optimize/OptimizePage.tsx src/features/optimize/OptimizePage.test.tsx
git commit -m "feat: add automatic optimize task queue"
```

---

### Task 5: Finish Coverage For Requeue, Cancel, Retry, Save, Upload

**Files:**

- Modify: `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/optimize/OptimizePage.test.tsx`
- Modify: `/Users/frankwei/Code/DesktopApp/pic-piper/src/features/optimize/OptimizePage.tsx`

- [ ] **Step 1: Add quality requeue test**

Add:

```tsx
it("recompresses existing items after global quality changes", async () => {
  vi.useFakeTimers();
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

  await user.click(screen.getByRole("button", { name: /choose images/i }));
  await screen.findByText(/1.2 MB.*240 KB/);

  fireEvent.change(screen.getByRole("slider", { name: /quality/i }), { target: { value: "60" } });
  vi.advanceTimersByTime(450);

  expect(compressImage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      settings: expect.objectContaining({ quality: 60 }),
    }),
  );
  vi.useRealTimers();
});
```

- [ ] **Step 2: Add format-only requeue test**

Add:

```tsx
it("changing one card format recompresses only that item", async () => {
  const user = userEvent.setup();
  render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

  await user.click(screen.getByRole("button", { name: /choose images/i }));
  await screen.findByText(/1.2 MB.*240 KB/);
  compressImage.mockClear();

  await user.selectOptions(screen.getByLabelText(/format for real-photo\.jpg/i), "webp");

  expect(compressImage).toHaveBeenCalledTimes(1);
  expect(compressImage).toHaveBeenCalledWith(
    expect.objectContaining({
      outputFileName: "real-photo.webp",
      settings: expect.objectContaining({ targetFormat: "webp" }),
    }),
  );
});
```

- [ ] **Step 3: Add cancel stale-result test**

Mock `compressImage` with a deferred promise in this test, click cancel while compressing, resolve the promise, and assert the card stays cancelled:

```tsx
it("does not apply late compression results after cancellation", async () => {
  let resolveCompression!: (value: Awaited<ReturnType<typeof compressImage>>) => void;
  compressImage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveCompression = resolve;
      }),
  );
  const user = userEvent.setup();
  render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

  await user.click(screen.getByRole("button", { name: /choose images/i }));
  await screen.findByText(/compressing/i);
  await user.click(screen.getByRole("button", { name: /cancel real-photo\.jpg/i }));

  resolveCompression({
    sourcePath: "/tmp/real-photo.jpg",
    outputPath: "/tmp/pic-piper/run-1/real-photo.jpg",
    outputFileName: "real-photo.jpg",
    originalBytes: 1_200_000,
    outputBytes: 240_000,
    targetFormat: "jpg",
  });

  expect(await screen.findByText(/cancelled/i)).toBeInTheDocument();
  expect(screen.queryByText(/1.2 MB.*240 KB/)).not.toBeInTheDocument();
});
```

- [ ] **Step 4: Update save and upload tests**

Keep existing save/upload assertions, but remove the manual compress click. The flow should be:

```tsx
await user.click(screen.getByRole("button", { name: /choose images/i }));
await screen.findByText(/1.2 MB.*240 KB/);
await user.click(screen.getByRole("button", { name: "Save to local folder" }));
```

Upload should similarly wait for the compressed result before clicking `Upload to S3`.

- [ ] **Step 5: Run OptimizePage tests**

Run:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test -- src/features/optimize/OptimizePage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

Run:

```bash
git add src/features/optimize/OptimizePage.tsx src/features/optimize/OptimizePage.test.tsx
git commit -m "test: cover optimize task queue interactions"
```

---

### Task 6: Full Verification And Cleanup

**Files:**

- Modify only files required by failing checks.

- [ ] **Step 1: Search for stale preset and batch UI references**

Run:

```bash
rg -n "CompressionPreset|presets|Preset|Apply preset|selectedPresetId|Compress\"|compressBatch" src src-tauri
```

Expected:

- No `CompressionPreset`, `presets`, `Preset`, `Apply preset`, or `selectedPresetId` references.
- `compressBatch` may remain only in backend/API if intentionally kept; it must not be used by `OptimizePage`.

- [ ] **Step 2: Run frontend unit tests**

Run:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test
```

Expected: PASS.

- [ ] **Step 3: Run frontend build**

Run:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm build
```

Expected: PASS.

- [ ] **Step 4: Run Rust tests**

Run:

```bash
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test
```

Expected: PASS.

- [ ] **Step 5: Run Rust formatting check**

Run:

```bash
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo fmt --check
```

Expected: PASS.

- [ ] **Step 6: Review final diff**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected:

- Only intended files are modified.
- No whitespace errors.
- The pre-existing `/Users/frankwei/Code/DesktopApp/pic-piper/src/components/ui/Slider.tsx` local modification is not reverted unless it was intentionally incorporated by the implementer.

- [ ] **Step 7: Final commit**

If Task 6 required fixes, commit them:

```bash
git add src src-tauri
git commit -m "fix: polish optimize task queue"
```

If Task 6 had no file changes, do not create an empty commit.
