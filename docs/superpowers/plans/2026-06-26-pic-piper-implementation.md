# Pic Piper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build the first GUI version of Pic Piper: per-image optimization, direct S3 upload after compression, and a simplified S3 Gallery for viewing, copying URLs, uploading, downloading, and deleting images.

**Architecture:** Keep React responsible for UI state and Tauri commands responsible for filesystem, image processing, credential storage, local persistence, and S3 calls. Build in vertical slices: local app shell and state first, pure Rust domain tests next, then optimizer, S3 Gallery, and finally the direct upload handoff from compression results to Gallery.

**Tech Stack:** Tauri 2, React 19, TypeScript, Vite, Vitest, Rust 2021, `image` 0.25.10, `aws-sdk-s3` 1.137.0, `aws-config` 1.8.18, `keyring` 4.1.2, local JSON persistence, MinIO/mock S3 for integration tests.

---

## Scope Check

The approved design includes two product surfaces, but they are connected through one explicit workflow. Keep this as one implementation plan because each task produces a runnable increment of the same desktop app:

1. App shell and state model.
2. Settings/profile/naming foundations.
3. Optimizer backend and UI.
4. S3 Gallery backend and UI.
5. Direct upload from compression results into S3 Gallery.

Do not add auto-upload, a standalone upload queue, S3 rename/move, presigned URLs, full bucket indexing, tags, favorites, or folder watching.

## File Structure

Create or modify these files:

- `package.json`: add test scripts and frontend test dependencies.
- `.gitignore`: ignore `.superpowers/` local brainstorming artifacts.
- `src/App.tsx`: route between `Optimize`, `S3 Gallery`, and `Settings`.
- `src/App.css`: replace starter styles with desktop app layout styles.
- `src/types.ts`: shared frontend domain types.
- `src/api/tauri.ts`: typed wrappers around Tauri `invoke`.
- `src/state/appState.ts`: lightweight React state helpers for selected profile/prefix and highlighted uploaded keys.
- `src/components/Layout.tsx`: app navigation shell.
- `src/features/optimize/OptimizePage.tsx`: import list, per-image controls, compression results.
- `src/features/gallery/S3GalleryPage.tsx`: simplified S3 image manager.
- `src/features/settings/SettingsPage.tsx`: profiles, defaults, naming template.
- `src/test/setup.ts`: frontend test setup.
- `src/**/*.test.tsx`: focused frontend tests.
- `src-tauri/Cargo.toml`: add Rust dependencies and dev-dependencies.
- `src-tauri/src/lib.rs`: register Tauri commands and state.
- `src-tauri/src/error.rs`: serializable app error type.
- `src-tauri/src/models.rs`: shared Rust request/response structs.
- `src-tauri/src/settings.rs`: JSON persistence for app settings.
- `src-tauri/src/naming.rs`: object key template rendering.
- `src-tauri/src/credentials.rs`: secure storage with fallback config path.
- `src-tauri/src/history.rs`: upload history persistence.
- `src-tauri/src/optimizer.rs`: image inspect/estimate/compress commands.
- `src-tauri/src/gallery.rs`: public URL joining and S3 operations.
- `src-tauri/src/state.rs`: app data directories and dependency wiring.
- `src-tauri/tests/*.rs`: Rust integration and unit-style tests.

## Dependency Decisions

Use these initial dependencies:

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
tokio = { version = "1", features = ["macros", "rt-multi-thread", "fs"] }
image = { version = "0.25.10", default-features = true }
aws-config = "1.8.18"
aws-sdk-s3 = "1.137.0"
aws-credential-types = "1"
aws-smithy-runtime-api = "1"
keyring = "4.1.2"
chrono = { version = "0.4", features = ["serde"] }
sha2 = "0.10"
hex = "0.4"
slug = "0.1"

[dev-dependencies]
tempfile = "3.27.0"
```

Use these frontend dev dependencies:

```bash
pnpm add -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

---

### Task 1: Test Harness And Starter Cleanup

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `src/test/setup.ts`
- Create: `src/App.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [x] **Step 1: Add frontend test dependencies**

Run:

```bash
pnpm add -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

Expected: `package.json` and `pnpm-lock.yaml` update successfully.

- [x] **Step 2: Add scripts to `package.json`**

Change the scripts block to:

```json
"scripts": {
  "dev": "vite",
  "build": "tsc && vite build",
  "preview": "vite preview",
  "test": "vitest run",
  "test:watch": "vitest",
  "tauri": "tauri"
}
```

- [x] **Step 3: Ignore local brainstorming artifacts**

Append this to `.gitignore`:

```gitignore

# Local planning/mockup artifacts
.superpowers/
```

- [x] **Step 4: Create frontend test setup**

Create `src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [x] **Step 5: Configure Vitest in `vite.config.ts`**

Add the `test` block and the reference comment:

```ts
/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
  },
}));
```

- [x] **Step 6: Write a failing app shell test**

Create `src/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import App from "./App";

describe("App", () => {
  it("renders the Pic Piper navigation", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Pic Piper" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Optimize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "S3 Gallery" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });
});
```

- [x] **Step 7: Run the test and verify it fails**

Run:

```bash
pnpm test -- src/App.test.tsx
```

Expected: FAIL because the starter Tauri page does not render Pic Piper navigation.

- [x] **Step 8: Replace starter `src/App.tsx` with a minimal shell**

Use:

```tsx
import { useState } from "react";
import "./App.css";

type View = "optimize" | "gallery" | "settings";

const NAV_ITEMS: Array<{ id: View; label: string }> = [
  { id: "optimize", label: "Optimize" },
  { id: "gallery", label: "S3 Gallery" },
  { id: "settings", label: "Settings" },
];

function App() {
  const [view, setView] = useState<View>("optimize");

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <h1>Pic Piper</h1>
        <nav aria-label="Main navigation">
          {NAV_ITEMS.map((item) => (
            <button
              className={view === item.id ? "nav-button active" : "nav-button"}
              key={item.id}
              onClick={() => setView(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <section className="workspace">
        {view === "optimize" && <h2>Optimize</h2>}
        {view === "gallery" && <h2>S3 Gallery</h2>}
        {view === "settings" && <h2>Settings</h2>}
      </section>
    </main>
  );
}

export default App;
```

- [x] **Step 9: Replace `src/App.css` with base app styles**

Use:

```css
:root {
  color: #18202a;
  background: #f4f6f8;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
  font-size: 16px;
  line-height: 1.5;
  font-weight: 400;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 960px;
  min-height: 100vh;
}

button,
input,
select {
  font: inherit;
}

.app-shell {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  min-height: 100vh;
}

.sidebar {
  background: #17202b;
  color: #f8fafc;
  padding: 24px 18px;
}

.sidebar h1 {
  margin: 0 0 28px;
  font-size: 24px;
}

.sidebar nav {
  display: grid;
  gap: 8px;
}

.nav-button {
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #d8dee8;
  cursor: pointer;
  padding: 10px 12px;
  text-align: left;
}

.nav-button.active,
.nav-button:hover {
  background: #2f4358;
  color: #ffffff;
}

.workspace {
  min-width: 0;
  padding: 24px;
}
```

- [x] **Step 10: Verify and commit**

Run:

```bash
pnpm test -- src/App.test.tsx
pnpm build
```

Expected: both commands pass.

Commit:

```bash
git add .gitignore package.json pnpm-lock.yaml vite.config.ts src/App.tsx src/App.css src/App.test.tsx src/test/setup.ts
git commit -m "test: add frontend harness and app shell"
```

---

### Task 2: Frontend Domain Model And Page Skeletons

**Files:**
- Create: `src/types.ts`
- Create: `src/components/Layout.tsx`
- Create: `src/features/optimize/OptimizePage.tsx`
- Create: `src/features/gallery/S3GalleryPage.tsx`
- Create: `src/features/settings/SettingsPage.tsx`
- Create: `src/features/optimize/OptimizePage.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [x] **Step 1: Create shared frontend types**

Create `src/types.ts`:

```ts
export type AppView = "optimize" | "gallery" | "settings";

export type ImageFormat = "jpg" | "png" | "webp" | "avif" | "heif";

export type ImageStatus = "pending" | "ready" | "compressing" | "compressed" | "failed";

export interface CompressionSettings {
  targetFormat: ImageFormat;
  quality: number;
  maxWidth: number;
  maxHeight: number;
  allowUpscale: boolean;
  removeGps: boolean;
}

export interface OptimizeItem {
  id: string;
  sourcePath: string;
  fileName: string;
  sourceFormat: ImageFormat | "unknown";
  originalBytes: number;
  estimatedBytes?: number;
  outputBytes?: number;
  outputPath?: string;
  outputFileName?: string;
  status: ImageStatus;
  warning?: string;
  error?: string;
  settings: CompressionSettings;
}

export interface CompressionResult {
  items: OptimizeItem[];
  totalOriginalBytes: number;
  totalOutputBytes: number;
}

export interface S3ProfileSummary {
  id: string;
  name: string;
  bucket: string;
  endpoint: string;
  region: string;
  defaultPrefix: string;
  publicBaseUrl?: string;
}

export interface GalleryObject {
  key: string;
  size: number;
  lastModified?: string;
  publicUrl?: string;
  isImage: boolean;
}
```

- [x] **Step 2: Create layout component**

Create `src/components/Layout.tsx`:

```tsx
import type { AppView } from "../types";

const NAV_ITEMS: Array<{ id: AppView; label: string }> = [
  { id: "optimize", label: "Optimize" },
  { id: "gallery", label: "S3 Gallery" },
  { id: "settings", label: "Settings" },
];

interface LayoutProps {
  activeView: AppView;
  children: React.ReactNode;
  onViewChange: (view: AppView) => void;
}

export function Layout({ activeView, children, onViewChange }: LayoutProps) {
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <h1>Pic Piper</h1>
        <nav aria-label="Main navigation">
          {NAV_ITEMS.map((item) => (
            <button
              className={activeView === item.id ? "nav-button active" : "nav-button"}
              key={item.id}
              onClick={() => onViewChange(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <section className="workspace">{children}</section>
    </main>
  );
}
```

- [x] **Step 3: Create Optimize skeleton**

Create `src/features/optimize/OptimizePage.tsx`:

```tsx
import { useState } from "react";
import type { OptimizeItem } from "../../types";

const DEFAULT_SETTINGS = {
  targetFormat: "webp" as const,
  quality: 68,
  maxWidth: 1600,
  maxHeight: 1600,
  allowUpscale: false,
  removeGps: true,
};

const SAMPLE_ITEMS: OptimizeItem[] = [
  {
    id: "sample-1",
    sourcePath: "/sample/photo-01.jpg",
    fileName: "photo-01.jpg",
    sourceFormat: "jpg",
    originalBytes: 4_200_000,
    estimatedBytes: 720_000,
    status: "pending",
    settings: DEFAULT_SETTINGS,
  },
];

export function OptimizePage() {
  const [items, setItems] = useState<OptimizeItem[]>(SAMPLE_ITEMS);

  const updateQuality = (id: string, quality: number) => {
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              estimatedBytes: Math.round(item.originalBytes * (quality / 100) * 0.25),
              settings: { ...item.settings, quality },
            }
          : item,
      ),
    );
  };

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h2>Optimize</h2>
          <p>Apply a preset, tune each image, then compress.</p>
        </div>
        <div className="header-actions">
          <button type="button">Apply preset</button>
          <button type="button">Compress</button>
        </div>
      </header>

      <section className="drop-zone">Drop images here or choose files</section>

      <section className="item-list" aria-label="Images to optimize">
        {items.map((item) => (
          <article className="image-row" key={item.id}>
            <div>
              <strong>{item.fileName}</strong>
              <p>
                {item.sourceFormat.toUpperCase()} -&gt; {item.settings.targetFormat.toUpperCase()} |{" "}
                {formatBytes(item.originalBytes)} =&gt; {formatBytes(item.estimatedBytes ?? 0)}
              </p>
            </div>
            <label>
              Quality {item.settings.quality}%
              <input
                max={100}
                min={1}
                onChange={(event) => updateQuality(item.id, Number(event.currentTarget.value))}
                type="range"
                value={item.settings.quality}
              />
            </label>
          </article>
        ))}
      </section>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}
```

- [x] **Step 4: Create S3 Gallery skeleton**

Create `src/features/gallery/S3GalleryPage.tsx`:

```tsx
export function S3GalleryPage() {
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h2>S3 Gallery</h2>
          <p>Browse a profile and prefix, then copy URLs or manage images.</p>
        </div>
        <button type="button">Upload local images</button>
      </header>
      <section className="gallery-toolbar">
        <select aria-label="Profile">
          <option>Choose profile</option>
        </select>
        <input aria-label="Prefix" placeholder="images/2026/06" />
        <input aria-label="Search current prefix" placeholder="Search current prefix" />
      </section>
      <section className="empty-state">No profile selected.</section>
    </div>
  );
}
```

- [x] **Step 5: Create Settings skeleton**

Create `src/features/settings/SettingsPage.tsx`:

```tsx
export function SettingsPage() {
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h2>Settings</h2>
          <p>Manage S3 profiles, presets, naming, and output defaults.</p>
        </div>
      </header>
      <section className="settings-grid">
        <article className="panel">
          <h3>Profiles</h3>
          <p>No profiles configured.</p>
        </article>
        <article className="panel">
          <h3>Naming template</h3>
          <code>{"{yyyy}/{mm}/{slug}-{hash}.{ext}"}</code>
        </article>
      </section>
    </div>
  );
}
```

- [x] **Step 6: Update `src/App.tsx` to use pages**

Use:

```tsx
import { useState } from "react";
import { Layout } from "./components/Layout";
import { S3GalleryPage } from "./features/gallery/S3GalleryPage";
import { OptimizePage } from "./features/optimize/OptimizePage";
import { SettingsPage } from "./features/settings/SettingsPage";
import type { AppView } from "./types";
import "./App.css";

function App() {
  const [view, setView] = useState<AppView>("optimize");

  return (
    <Layout activeView={view} onViewChange={setView}>
      {view === "optimize" && <OptimizePage />}
      {view === "gallery" && <S3GalleryPage />}
      {view === "settings" && <SettingsPage />}
    </Layout>
  );
}

export default App;
```

- [x] **Step 7: Extend CSS for page skeletons**

Append to `src/App.css`:

```css
.page-stack {
  display: grid;
  gap: 18px;
}

.page-header {
  align-items: start;
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.page-header h2 {
  margin: 0;
  font-size: 28px;
}

.page-header p {
  color: #5e6b78;
  margin: 4px 0 0;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.workspace button {
  border: 1px solid #c4ccd6;
  border-radius: 6px;
  background: #ffffff;
  color: #17202b;
  cursor: pointer;
  padding: 8px 12px;
}

.workspace button:hover {
  border-color: #62748a;
}

.drop-zone,
.empty-state,
.panel {
  border: 1px dashed #b9c3cf;
  border-radius: 8px;
  background: #ffffff;
  padding: 22px;
}

.item-list {
  display: grid;
  gap: 10px;
}

.image-row {
  align-items: center;
  background: #ffffff;
  border: 1px solid #d7dee7;
  border-radius: 8px;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 14px;
}

.image-row p {
  color: #5e6b78;
  margin: 4px 0 0;
}

.image-row label {
  display: grid;
  gap: 6px;
  min-width: 240px;
}

.gallery-toolbar,
.settings-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.gallery-toolbar input,
.gallery-toolbar select {
  border: 1px solid #c4ccd6;
  border-radius: 6px;
  padding: 8px 10px;
}
```

- [x] **Step 8: Test page skeleton behavior**

Create `src/features/optimize/OptimizePage.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OptimizePage } from "./OptimizePage";

describe("OptimizePage", () => {
  it("shows per-image size feedback and lets quality change", async () => {
    const user = userEvent.setup();
    render(<OptimizePage />);

    expect(screen.getByText(/photo-01.jpg/)).toBeInTheDocument();
    expect(screen.getByText(/4.2 MB => 720 KB/)).toBeInTheDocument();

    const slider = screen.getByRole("slider", { name: /Quality 68%/ });
    await user.clear(slider);
    await user.type(slider, "50");

    expect(screen.getByText(/Quality 50%/)).toBeInTheDocument();
  });
});
```

If `user.clear` does not work for range inputs, replace the action with:

```tsx
await user.click(slider);
slider.focus();
await user.keyboard("{ArrowLeft}{ArrowLeft}");
```

- [x] **Step 9: Verify and commit**

Run:

```bash
pnpm test
pnpm build
```

Expected: tests and build pass.

Commit:

```bash
git add src package.json pnpm-lock.yaml vite.config.ts
git commit -m "feat: add Pic Piper page skeletons"
```

---

### Task 3: Rust Domain Models, Naming, Settings, And History

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/error.rs`
- Create: `src-tauri/src/models.rs`
- Create: `src-tauri/src/naming.rs`
- Create: `src-tauri/src/settings.rs`
- Create: `src-tauri/src/history.rs`
- Create: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Add Rust dependencies**

Update `src-tauri/Cargo.toml` dependencies and dev-dependencies with the dependency block from this plan's Dependency Decisions section.

- [x] **Step 2: Create serializable error type**

Create `src-tauri/src/error.rs`:

```rust
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recoverable: true,
        }
    }

    pub fn fatal(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recoverable: false,
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;
```

- [x] **Step 3: Create shared Rust models**

Create `src-tauri/src/models.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct S3Profile {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub credential_ref: Option<String>,
    pub path_style: bool,
    pub public_base_url: Option<String>,
    pub default_prefix: String,
    pub insecure_secret_fallback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompressionPreset {
    pub id: String,
    pub name: String,
    pub target_format: ImageFormat,
    pub quality: u8,
    pub max_width: u32,
    pub max_height: u32,
    pub allow_upscale: bool,
    pub remove_gps: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Jpg,
    Png,
    Webp,
    Avif,
    Heif,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub profiles: Vec<S3Profile>,
    pub presets: Vec<CompressionPreset>,
    pub naming_template: String,
    pub default_output_dir: Option<String>,
    pub default_profile_id: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            profiles: Vec::new(),
            presets: vec![CompressionPreset {
                id: "small-web".to_string(),
                name: "Small web image".to_string(),
                target_format: ImageFormat::Webp,
                quality: 68,
                max_width: 1600,
                max_height: 1600,
                allow_upscale: false,
                remove_gps: true,
            }],
            naming_template: "{yyyy}/{mm}/{slug}-{hash}.{ext}".to_string(),
            default_output_dir: None,
            default_profile_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadHistoryEntry {
    pub profile_id: String,
    pub bucket: String,
    pub object_key: String,
    pub public_url: Option<String>,
    pub uploaded_at: String,
    pub source_filename: String,
    pub output_filename: String,
    pub original_bytes: u64,
    pub uploaded_bytes: u64,
    pub target_format: ImageFormat,
}
```

- [x] **Step 4: Write naming tests first**

Create `src-tauri/src/naming.rs` with tests and stubs:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_default_template_with_slug_and_hash() {
        let key = render_object_key(
            "{yyyy}/{mm}/{slug}-{hash}.{ext}",
            "My Summer Photo.JPG",
            "jpg",
            "abcdef123456",
            chrono::NaiveDate::from_ymd_opt(2026, 6, 26).unwrap(),
        )
        .unwrap();

        assert_eq!(key, "2026/06/my-summer-photo-abcdef12.jpg");
    }

    #[test]
    fn rejects_templates_without_extension() {
        let err = render_object_key(
            "{yyyy}/{mm}/{slug}-{hash}",
            "photo.jpg",
            "jpg",
            "abcdef123456",
            chrono::NaiveDate::from_ymd_opt(2026, 6, 26).unwrap(),
        )
        .unwrap_err();

        assert_eq!(err.code, "invalidTemplate");
    }
}

use crate::error::{AppError, AppResult};

pub fn render_object_key(
    template: &str,
    source_filename: &str,
    ext: &str,
    content_hash: &str,
    date: chrono::NaiveDate,
) -> AppResult<String> {
    if !template.contains("{ext}") {
        return Err(AppError::new(
            "invalidTemplate",
            "Naming template must include {ext}.",
        ));
    }

    let stem = source_filename
        .rsplit_once('.')
        .map(|(name, _)| name)
        .unwrap_or(source_filename);
    let slug = slug::slugify(stem);
    let short_hash = content_hash.chars().take(8).collect::<String>();

    Ok(template
        .replace("{yyyy}", &date.format("%Y").to_string())
        .replace("{mm}", &date.format("%m").to_string())
        .replace("{slug}", &slug)
        .replace("{hash}", &short_hash)
        .replace("{ext}", ext.trim_start_matches('.')))
}
```

- [x] **Step 5: Create settings persistence**

Create `src-tauri/src/settings.rs`:

```rust
use std::{fs, path::Path};

use crate::{
    error::{AppError, AppResult},
    models::AppSettings,
};

pub fn load_settings(path: &Path) -> AppResult<AppSettings> {
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let content = fs::read_to_string(path)
        .map_err(|err| AppError::new("settingsReadFailed", err.to_string()))?;
    serde_json::from_str(&content)
        .map_err(|err| AppError::new("settingsParseFailed", err.to_string()))
}

pub fn save_settings(path: &Path, settings: &AppSettings) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| AppError::new("settingsDirFailed", err.to_string()))?;
    }

    let content = serde_json::to_string_pretty(settings)
        .map_err(|err| AppError::new("settingsSerializeFailed", err.to_string()))?;
    fs::write(path, content).map_err(|err| AppError::new("settingsWriteFailed", err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_settings_returns_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let settings = load_settings(&dir.path().join("settings.json")).unwrap();
        assert_eq!(settings.naming_template, "{yyyy}/{mm}/{slug}-{hash}.{ext}");
        assert_eq!(settings.presets.len(), 1);
    }
}
```

- [x] **Step 6: Create upload history persistence**

Create `src-tauri/src/history.rs`:

```rust
use std::{fs, path::Path};

use crate::{
    error::{AppError, AppResult},
    models::UploadHistoryEntry,
};

pub fn load_history(path: &Path) -> AppResult<Vec<UploadHistoryEntry>> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content =
        fs::read_to_string(path).map_err(|err| AppError::new("historyReadFailed", err.to_string()))?;
    serde_json::from_str(&content)
        .map_err(|err| AppError::new("historyParseFailed", err.to_string()))
}

pub fn append_history(path: &Path, entry: UploadHistoryEntry) -> AppResult<()> {
    let mut entries = load_history(path)?;
    entries.insert(0, entry);
    if entries.len() > 500 {
        entries.truncate(500);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| AppError::new("historyDirFailed", err.to_string()))?;
    }
    let content = serde_json::to_string_pretty(&entries)
        .map_err(|err| AppError::new("historySerializeFailed", err.to_string()))?;
    fs::write(path, content).map_err(|err| AppError::new("historyWriteFailed", err.to_string()))
}
```

- [x] **Step 7: Create app data path state**

Create `src-tauri/src/state.rs`:

```rust
use std::path::PathBuf;

use tauri::Manager;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub settings_path: PathBuf,
    pub history_path: PathBuf,
    pub credential_fallback_dir: PathBuf,
}

impl AppPaths {
    pub fn from_app_handle(app: &tauri::AppHandle) -> AppResult<Self> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| AppError::new("appDataDirFailed", err.to_string()))?;
        Ok(Self {
            settings_path: data_dir.join("settings.json"),
            history_path: data_dir.join("upload-history.json"),
            credential_fallback_dir: data_dir.join("credential-fallback"),
            data_dir,
        })
    }
}
```

- [x] **Step 8: Register modules in `src-tauri/src/lib.rs`**

Replace starter command wiring with:

```rust
mod error;
mod history;
mod models;
mod naming;
mod state;
mod settings;

use models::AppSettings;

#[tauri::command]
fn get_default_settings() -> AppSettings {
    AppSettings::default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = state::AppPaths::from_app_handle(app.handle())?;
            app.manage(paths);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_default_settings])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [x] **Step 9: Verify and commit**

Run:

```bash
cd src-tauri
cargo test
cargo fmt
cd ..
pnpm build
```

Expected: Rust tests pass and frontend build still passes.

Commit:

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src
git commit -m "feat: add core settings and naming models"
```

---

### Task 4: Credential Storage Policy

**Files:**
- Create: `src-tauri/src/credentials.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/models.rs`
- Create: `src-tauri/src/credentials_test.rs` only if unit tests become too large for `credentials.rs`

- [x] **Step 1: Add credential request/response models**

Append to `src-tauri/src/models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveCredentialRequest {
    pub profile_id: String,
    pub secret_access_key: String,
    pub allow_insecure_fallback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveCredentialResponse {
    pub credential_ref: String,
    pub insecure_fallback_used: bool,
}
```

- [x] **Step 2: Write credential storage with fallback**

Create `src-tauri/src/credentials.rs`:

```rust
use std::{fs, path::Path};

use crate::{
    error::{AppError, AppResult},
    models::{SaveCredentialRequest, SaveCredentialResponse},
};

const SERVICE_NAME: &str = "xyz.frankwei.pic-piper";

pub fn credential_ref(profile_id: &str) -> String {
    format!("s3:{profile_id}")
}

pub fn save_secret(
    fallback_dir: &Path,
    request: SaveCredentialRequest,
) -> AppResult<SaveCredentialResponse> {
    let key_ref = credential_ref(&request.profile_id);
    let entry = keyring::Entry::new(SERVICE_NAME, &key_ref);

    if let Ok(entry) = entry {
        if entry.set_password(&request.secret_access_key).is_ok() {
            return Ok(SaveCredentialResponse {
                credential_ref: key_ref,
                insecure_fallback_used: false,
            });
        }
    }

    if !request.allow_insecure_fallback {
        return Err(AppError::new(
            "secureCredentialUnavailable",
            "System credential storage is unavailable. Enable local fallback to save this profile.",
        ));
    }

    fs::create_dir_all(fallback_dir)
        .map_err(|err| AppError::new("credentialFallbackDirFailed", err.to_string()))?;
    fs::write(
        fallback_dir.join(format!("{}.secret", request.profile_id)),
        request.secret_access_key,
    )
    .map_err(|err| AppError::new("credentialFallbackWriteFailed", err.to_string()))?;

    Ok(SaveCredentialResponse {
        credential_ref: key_ref,
        insecure_fallback_used: true,
    })
}

pub fn load_secret(fallback_dir: &Path, profile_id: &str) -> AppResult<String> {
    let key_ref = credential_ref(profile_id);
    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, &key_ref) {
        if let Ok(secret) = entry.get_password() {
            return Ok(secret);
        }
    }

    fs::read_to_string(fallback_dir.join(format!("{profile_id}.secret")))
        .map_err(|_| AppError::new("credentialMissing", "No saved credential found for profile."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_ref_is_stable() {
        assert_eq!(credential_ref("r2-main"), "s3:r2-main");
    }

    #[test]
    fn fallback_requires_explicit_permission() {
        let dir = tempfile::tempdir().unwrap();
        let result = save_secret(
            dir.path(),
            SaveCredentialRequest {
                profile_id: "example".to_string(),
                secret_access_key: "secret".to_string(),
                allow_insecure_fallback: false,
            },
        );

        if let Err(err) = result {
            assert_eq!(err.code, "secureCredentialUnavailable");
        }
    }
}
```

- [x] **Step 3: Register module**

Add to `src-tauri/src/lib.rs`:

```rust
mod credentials;
```

- [x] **Step 4: Verify and commit**

Run:

```bash
cd src-tauri
cargo test credentials
cargo test
cargo fmt
```

Expected: credential tests pass. On machines with working keychain, the fallback test may save to secure storage and return `Ok`; the test already accepts that by only asserting on the error path.

Commit:

```bash
git add src-tauri/src src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: add credential storage policy"
```

---

### Task 5: Optimizer Backend Commands

**Files:**
- Create: `src-tauri/src/optimizer.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Add optimizer request/response models**

Append to `src-tauri/src/models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompressionSettings {
    pub target_format: ImageFormat,
    pub quality: u8,
    pub max_width: u32,
    pub max_height: u32,
    pub allow_upscale: bool,
    pub remove_gps: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InspectImageRequest {
    pub path: String,
    pub settings: CompressionSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageInspection {
    pub path: String,
    pub file_name: String,
    pub source_format: Option<ImageFormat>,
    pub original_bytes: u64,
    pub width: u32,
    pub height: u32,
    pub estimated_bytes: Option<u64>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompressImageRequest {
    pub source_path: String,
    pub output_dir: String,
    pub output_file_name: String,
    pub settings: CompressionSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompressImageResult {
    pub source_path: String,
    pub output_path: String,
    pub output_file_name: String,
    pub original_bytes: u64,
    pub output_bytes: u64,
    pub target_format: ImageFormat,
    pub warning: Option<String>,
}
```

- [x] **Step 2: Create optimizer implementation**

Create `src-tauri/src/optimizer.rs`:

```rust
use std::{
    fs,
    path::{Path, PathBuf},
};

use image::{codecs::jpeg::JpegEncoder, DynamicImage, GenericImageView, ImageFormat as CodecFormat};

use crate::{
    error::{AppError, AppResult},
    models::{
        CompressImageRequest, CompressImageResult, ImageFormat, ImageInspection, InspectImageRequest,
    },
};

pub fn inspect_image(request: InspectImageRequest) -> AppResult<ImageInspection> {
    let path = PathBuf::from(&request.path);
    let metadata =
        fs::metadata(&path).map_err(|err| AppError::new("imageReadFailed", err.to_string()))?;
    let reader = image::ImageReader::open(&path)
        .map_err(|err| AppError::new("imageOpenFailed", err.to_string()))?
        .with_guessed_format()
        .map_err(|err| AppError::new("imageFormatFailed", err.to_string()))?;
    let source_format = reader.format().and_then(map_codec_format);
    let dimensions = reader
        .into_dimensions()
        .map_err(|err| AppError::new("imageDimensionFailed", err.to_string()))?;

    Ok(ImageInspection {
        path: request.path,
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("image")
            .to_string(),
        source_format,
        original_bytes: metadata.len(),
        width: dimensions.0,
        height: dimensions.1,
        estimated_bytes: Some(estimate_bytes(metadata.len(), request.settings.quality)),
        warning: None,
    })
}

pub fn compress_image(request: CompressImageRequest) -> AppResult<CompressImageResult> {
    let source = PathBuf::from(&request.source_path);
    let original_bytes = fs::metadata(&source)
        .map_err(|err| AppError::new("imageReadFailed", err.to_string()))?
        .len();
    let image = image::open(&source).map_err(|err| AppError::new("imageDecodeFailed", err.to_string()))?;
    let resized = resize_if_needed(image, request.settings.max_width, request.settings.max_height, request.settings.allow_upscale);

    fs::create_dir_all(&request.output_dir)
        .map_err(|err| AppError::new("outputDirFailed", err.to_string()))?;
    let output_path = Path::new(&request.output_dir).join(&request.output_file_name);

    match request.settings.target_format {
        ImageFormat::Jpg => write_jpeg(&resized, &output_path, request.settings.quality)?,
        ImageFormat::Png => resized
            .save_with_format(&output_path, CodecFormat::Png)
            .map_err(|err| AppError::new("imageEncodeFailed", err.to_string()))?,
        ImageFormat::Webp => resized
            .save_with_format(&output_path, CodecFormat::WebP)
            .map_err(|err| AppError::new("imageEncodeFailed", err.to_string()))?,
        ImageFormat::Avif => resized
            .save_with_format(&output_path, CodecFormat::Avif)
            .map_err(|err| AppError::new("imageEncodeFailed", err.to_string()))?,
        ImageFormat::Heif => {
            return Err(AppError::new(
                "codecUnavailable",
                "HEIF/HEIC output is not available in the built-in encoder.",
            ));
        }
    }

    let output_bytes = fs::metadata(&output_path)
        .map_err(|err| AppError::new("outputReadFailed", err.to_string()))?
        .len();

    Ok(CompressImageResult {
        source_path: request.source_path,
        output_path: output_path.to_string_lossy().to_string(),
        output_file_name: request.output_file_name,
        original_bytes,
        output_bytes,
        target_format: request.settings.target_format,
        warning: gps_warning(request.settings.remove_gps),
    })
}

fn estimate_bytes(original_bytes: u64, quality: u8) -> u64 {
    let quality_factor = quality.clamp(1, 100) as f64 / 100.0;
    (original_bytes as f64 * quality_factor * 0.35).max(1024.0).round() as u64
}

fn resize_if_needed(image: DynamicImage, max_width: u32, max_height: u32, allow_upscale: bool) -> DynamicImage {
    let (width, height) = image.dimensions();
    if !allow_upscale && width <= max_width && height <= max_height {
        return image;
    }
    image.thumbnail(max_width, max_height)
}

fn write_jpeg(image: &DynamicImage, output_path: &Path, quality: u8) -> AppResult<()> {
    let file = fs::File::create(output_path)
        .map_err(|err| AppError::new("outputWriteFailed", err.to_string()))?;
    let mut encoder = JpegEncoder::new_with_quality(file, quality.clamp(1, 100));
    encoder
        .encode_image(image)
        .map_err(|err| AppError::new("imageEncodeFailed", err.to_string()))
}

fn map_codec_format(format: CodecFormat) -> Option<ImageFormat> {
    match format {
        CodecFormat::Jpeg => Some(ImageFormat::Jpg),
        CodecFormat::Png => Some(ImageFormat::Png),
        CodecFormat::WebP => Some(ImageFormat::Webp),
        CodecFormat::Avif => Some(ImageFormat::Avif),
        _ => None,
    }
}

fn gps_warning(remove_gps: bool) -> Option<String> {
    if remove_gps {
        Some("GPS metadata removed when encoder metadata support allowed it.".to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CompressionSettings;

    #[test]
    fn estimate_decreases_with_lower_quality() {
        assert!(estimate_bytes(1_000_000, 50) < estimate_bytes(1_000_000, 90));
    }

    #[test]
    fn heif_output_returns_codec_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("sample.png");
        DynamicImage::new_rgb8(20, 20).save(&input).unwrap();

        let result = compress_image(CompressImageRequest {
            source_path: input.to_string_lossy().to_string(),
            output_dir: dir.path().to_string_lossy().to_string(),
            output_file_name: "sample.heif".to_string(),
            settings: CompressionSettings {
                target_format: ImageFormat::Heif,
                quality: 70,
                max_width: 20,
                max_height: 20,
                allow_upscale: false,
                remove_gps: true,
            },
        });

        assert_eq!(result.unwrap_err().code, "codecUnavailable");
    }
}
```

- [x] **Step 3: Register optimizer commands**

Modify `src-tauri/src/lib.rs`:

```rust
mod credentials;
mod error;
mod history;
mod models;
mod naming;
mod optimizer;
mod settings;

use error::AppResult;
use models::{AppSettings, CompressImageRequest, CompressImageResult, ImageInspection, InspectImageRequest};

#[tauri::command]
fn get_default_settings() -> AppSettings {
    AppSettings::default()
}

#[tauri::command]
fn inspect_image(request: InspectImageRequest) -> AppResult<ImageInspection> {
    optimizer::inspect_image(request)
}

#[tauri::command]
fn compress_image(request: CompressImageRequest) -> AppResult<CompressImageResult> {
    optimizer::compress_image(request)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_default_settings,
            inspect_image,
            compress_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [x] **Step 4: Verify and commit**

Run:

```bash
cd src-tauri
cargo test optimizer
cargo test
cargo fmt
cd ..
pnpm build
```

Expected: optimizer tests pass; if AVIF encoder compilation is slow, let it finish once and keep the dependency.

Commit:

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src
git commit -m "feat: add image optimizer commands"
```

---

### Task 6: Optimize UI With Result Screen

**Files:**
- Create: `src/api/tauri.ts`
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify: `src/features/optimize/OptimizePage.test.tsx`
- Modify: `src/types.ts`
- Modify: `src/App.css`

- [x] **Step 1: Create typed Tauri wrappers**

Create `src/api/tauri.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import type { CompressionSettings, OptimizeItem } from "../types";

export interface InspectImageRequest {
  path: string;
  settings: CompressionSettings;
}

export interface CompressImageRequest {
  sourcePath: string;
  outputDir: string;
  outputFileName: string;
  settings: CompressionSettings;
}

export interface CompressImageResult {
  sourcePath: string;
  outputPath: string;
  outputFileName: string;
  originalBytes: number;
  outputBytes: number;
  targetFormat: CompressionSettings["targetFormat"];
  warning?: string;
}

export const tauriApi = {
  inspectImage: (request: InspectImageRequest) =>
    invoke<OptimizeItem>("inspect_image", { request }),
  compressImage: (request: CompressImageRequest) =>
    invoke<CompressImageResult>("compress_image", { request }),
};
```

- [x] **Step 2: Add result mode test**

Update `src/features/optimize/OptimizePage.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OptimizePage } from "./OptimizePage";

describe("OptimizePage", () => {
  it("shows per-image size feedback and then compression result actions", async () => {
    const user = userEvent.setup();
    render(<OptimizePage />);

    expect(screen.getByText(/photo-01.jpg/)).toBeInTheDocument();
    expect(screen.getByText(/4.2 MB => 720 KB/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Compress" }));

    expect(screen.getByRole("heading", { name: "Compression results" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to local folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload to S3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to edit settings" })).toBeInTheDocument();
  });
});
```

- [x] **Step 3: Implement result screen in `OptimizePage.tsx`**

Replace `OptimizePage` with a component that keeps `mode: "edit" | "results"` and maps sample items to compressed output when `Compress` is clicked. Preserve the per-image quality controls from Task 2. The result screen must render:

```tsx
<h2>Compression results</h2>
<button type="button">Save to local folder</button>
<button type="button">Upload to S3</button>
<button type="button" onClick={() => setMode("edit")}>Back to edit settings</button>
```

Use this compression simulation until the file picker is wired:

```ts
const compressedItems = items.map((item) => ({
  ...item,
  status: "compressed" as const,
  outputBytes: item.estimatedBytes ?? item.originalBytes,
  outputFileName: item.fileName.replace(/\.[^.]+$/, `.${item.settings.targetFormat}`),
}));
```

- [x] **Step 4: Add result styles**

Append to `src/App.css`:

```css
.result-summary {
  background: #ffffff;
  border: 1px solid #d7dee7;
  border-radius: 8px;
  padding: 16px;
}

.result-actions {
  display: flex;
  gap: 8px;
}
```

- [x] **Step 5: Verify and commit**

Run:

```bash
pnpm test -- src/features/optimize/OptimizePage.test.tsx
pnpm test
pnpm build
```

Expected: tests and build pass.

Commit:

```bash
git add src
git commit -m "feat: add optimizer result workflow"
```

---

### Task 7: S3 Gallery Backend Foundations

**Files:**
- Create: `src-tauri/src/gallery.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Add gallery models**

Append to `src-tauri/src/models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GalleryObject {
    pub key: String,
    pub size: u64,
    pub last_modified: Option<String>,
    pub public_url: Option<String>,
    pub is_image: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListObjectsRequest {
    pub profile: S3Profile,
    pub prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteObjectRequest {
    pub profile: S3Profile,
    pub key: String,
}
```

- [x] **Step 2: Create pure gallery helpers and tests**

Create `src-tauri/src/gallery.rs`:

```rust
use crate::{
    error::{AppError, AppResult},
    models::{GalleryObject, S3Profile},
};

pub fn public_url(profile: &S3Profile, key: &str) -> AppResult<String> {
    let base = profile.public_base_url.as_deref().ok_or_else(|| {
        AppError::new(
            "publicBaseUrlMissing",
            "Set a Public Base URL before copying object URLs.",
        )
    })?;
    Ok(format!("{}/{}", base.trim_end_matches('/'), key.trim_start_matches('/')))
}

pub fn is_supported_image_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    [".jpg", ".jpeg", ".png", ".webp", ".avif", ".heif", ".heic"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
}

pub fn object_from_parts(profile: &S3Profile, key: String, size: u64, last_modified: Option<String>) -> GalleryObject {
    GalleryObject {
        public_url: public_url(profile, &key).ok(),
        is_image: is_supported_image_key(&key),
        key,
        size,
        last_modified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(base: Option<&str>) -> S3Profile {
        S3Profile {
            id: "p1".to_string(),
            name: "Profile".to_string(),
            endpoint: "http://localhost:9000".to_string(),
            region: "auto".to_string(),
            bucket: "images".to_string(),
            access_key_id: "key".to_string(),
            credential_ref: Some("s3:p1".to_string()),
            path_style: true,
            public_base_url: base.map(str::to_string),
            default_prefix: "images".to_string(),
            insecure_secret_fallback: false,
        }
    }

    #[test]
    fn joins_public_url_with_one_slash() {
        assert_eq!(
            public_url(&profile(Some("https://cdn.example.com/")), "/a/b.jpg").unwrap(),
            "https://cdn.example.com/a/b.jpg"
        );
    }

    #[test]
    fn missing_public_base_url_is_error() {
        assert_eq!(
            public_url(&profile(None), "a.jpg").unwrap_err().code,
            "publicBaseUrlMissing"
        );
    }
}
```

- [x] **Step 3: Register minimal gallery commands**

Add commands in `src-tauri/src/lib.rs`:

```rust
use models::{DeleteObjectRequest, GalleryObject, ListObjectsRequest};

#[tauri::command]
async fn list_gallery_objects(request: ListObjectsRequest) -> AppResult<Vec<GalleryObject>> {
    let _ = request;
    Ok(Vec::new())
}

#[tauri::command]
async fn delete_gallery_object(request: DeleteObjectRequest) -> AppResult<()> {
    let _ = request;
    Ok(())
}
```

Add these commands to `generate_handler!`.

- [x] **Step 4: Verify and commit**

Run:

```bash
cd src-tauri
cargo test gallery
cargo test
cargo fmt
cd ..
pnpm build
```

Expected: tests and build pass.

Commit:

```bash
git add src-tauri/src
git commit -m "feat: add gallery domain helpers"
```

---

### Task 8: S3 Gallery UI

**Files:**
- Modify: `src/api/tauri.ts`
- Modify: `src/features/gallery/S3GalleryPage.tsx`
- Create: `src/features/gallery/S3GalleryPage.test.tsx`
- Modify: `src/App.css`

- [x] **Step 1: Add gallery API wrappers**

Append to `src/api/tauri.ts`:

```ts
import type { GalleryObject, S3ProfileSummary } from "../types";

export interface ListGalleryObjectsRequest {
  profile: S3ProfileSummary;
  prefix: string;
}

export const galleryApi = {
  listObjects: (request: ListGalleryObjectsRequest) =>
    invoke<GalleryObject[]>("list_gallery_objects", { request }),
};
```

If the duplicate import conflicts with the existing file, merge the imports at the top.

- [x] **Step 2: Write gallery UI test**

Create `src/features/gallery/S3GalleryPage.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { S3GalleryPage } from "./S3GalleryPage";

describe("S3GalleryPage", () => {
  it("shows simplified manager actions without rename or move", () => {
    render(<S3GalleryPage />);

    expect(screen.getByRole("heading", { name: "S3 Gallery" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload local images" })).toBeInTheDocument();
    expect(screen.getByLabelText("Prefix")).toBeInTheDocument();
    expect(screen.queryByText(/rename/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/move/i)).not.toBeInTheDocument();
  });
});
```

- [x] **Step 3: Implement static gallery card grid**

Update `S3GalleryPage.tsx` so it includes a temporary sample object and the supported actions:

```tsx
const SAMPLE_OBJECTS = [
  {
    key: "2026/06/photo-01-abcdef12.webp",
    size: 720_000,
    publicUrl: "https://cdn.example.com/2026/06/photo-01-abcdef12.webp",
    isImage: true,
  },
];
```

Render buttons with these exact labels per object:

```tsx
Copy URL
View
Download
Delete
```

Do not add Rename or Move controls.

- [x] **Step 4: Add gallery styles**

Append to `src/App.css`:

```css
.gallery-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
}

.object-card {
  background: #ffffff;
  border: 1px solid #d7dee7;
  border-radius: 8px;
  display: grid;
  gap: 10px;
  padding: 12px;
}

.object-thumb {
  align-items: center;
  aspect-ratio: 4 / 3;
  background: #e9eef4;
  border-radius: 6px;
  color: #62748a;
  display: flex;
  justify-content: center;
}

.object-actions {
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
```

- [x] **Step 5: Verify and commit**

Run:

```bash
pnpm test -- src/features/gallery/S3GalleryPage.test.tsx
pnpm test
pnpm build
```

Expected: tests and build pass.

Commit:

```bash
git add src
git commit -m "feat: add simplified S3 gallery UI"
```

---

### Task 9: Real S3 List/Delete/Upload Commands

**Files:**
- Modify: `src-tauri/src/gallery.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Add upload model**

Append to `src-tauri/src/models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadObjectRequest {
    pub profile: S3Profile,
    pub source_path: String,
    pub object_key: String,
    pub content_type: Option<String>,
}
```

- [x] **Step 2: Implement S3 client builder**

Add to `src-tauri/src/gallery.rs`:

```rust
use aws_config::BehaviorVersion;
use aws_credential_types::Credentials;
use aws_sdk_s3::{config::Region, primitives::ByteStream, Client};
use aws_sdk_s3::config::SharedCredentialsProvider;
use crate::models::{DeleteObjectRequest, ListObjectsRequest, UploadObjectRequest};

async fn client_for(profile: &S3Profile, secret: String) -> Client {
    let credentials = Credentials::new(
        profile.access_key_id.clone(),
        secret,
        None,
        None,
        "pic-piper-profile",
    );
    let base = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(profile.region.clone()))
        .credentials_provider(SharedCredentialsProvider::new(credentials))
        .endpoint_url(profile.endpoint.clone())
        .load()
        .await;
    let mut builder = aws_sdk_s3::config::Builder::from(&base);
    if profile.path_style {
        builder = builder.force_path_style(true);
    }
    Client::from_conf(builder.build())
}
```

- [x] **Step 3: Implement list/delete/upload functions**

Add functions in `gallery.rs`:

```rust
pub async fn list_objects(request: ListObjectsRequest, secret: String) -> AppResult<Vec<GalleryObject>> {
    let client = client_for(&request.profile, secret).await;
    let response = client
        .list_objects_v2()
        .bucket(&request.profile.bucket)
        .prefix(&request.prefix)
        .send()
        .await
        .map_err(|err| AppError::new("s3ListFailed", err.to_string()))?;

    Ok(response
        .contents()
        .iter()
        .filter_map(|object| {
            let key = object.key()?.to_string();
            Some(object_from_parts(
                &request.profile,
                key,
                object.size().unwrap_or_default() as u64,
                object.last_modified().map(|dt| dt.to_string()),
            ))
        })
        .collect())
}

pub async fn delete_object(request: DeleteObjectRequest, secret: String) -> AppResult<()> {
    let client = client_for(&request.profile, secret).await;
    client
        .delete_object()
        .bucket(&request.profile.bucket)
        .key(&request.key)
        .send()
        .await
        .map_err(|err| AppError::new("s3DeleteFailed", err.to_string()))?;
    Ok(())
}

pub async fn upload_object(request: UploadObjectRequest, secret: String) -> AppResult<GalleryObject> {
    let client = client_for(&request.profile, secret).await;
    let body = ByteStream::from_path(&request.source_path)
        .await
        .map_err(|err| AppError::new("uploadReadFailed", err.to_string()))?;

    let mut upload = client
        .put_object()
        .bucket(&request.profile.bucket)
        .key(&request.object_key)
        .body(body);
    if let Some(content_type) = &request.content_type {
        upload = upload.content_type(content_type);
    }
    upload
        .send()
        .await
        .map_err(|err| AppError::new("s3UploadFailed", err.to_string()))?;

    let size = std::fs::metadata(&request.source_path)
        .map_err(|err| AppError::new("uploadReadFailed", err.to_string()))?
        .len();
    Ok(object_from_parts(&request.profile, request.object_key, size, None))
}
```

- [x] **Step 4: Wire commands with credential loading**

In `lib.rs`, command handlers should load the secret by profile id through `credentials::load_secret` and the managed `AppPaths`.

```rust
use state::AppPaths;
use tauri::State;

#[tauri::command]
async fn list_gallery_objects(
    paths: State<'_, AppPaths>,
    request: ListObjectsRequest,
) -> AppResult<Vec<GalleryObject>> {
    let secret = credentials::load_secret(
        &paths.credential_fallback_dir,
        &request.profile.id,
    )?;
    gallery::list_objects(request, secret).await
}
```

Repeat the same pattern for `delete_gallery_object` and `upload_gallery_object`.

- [x] **Step 5: Verify and commit**

Run:

```bash
cd src-tauri
cargo check
cargo test gallery
cargo fmt
```

Expected: code compiles and pure gallery tests pass. Real S3 behavior is verified later against configured profile or MinIO.

Commit:

```bash
git add src-tauri/src src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: add S3 gallery commands"
```

---

### Task 10: Settings Page, Profile Persistence, And Local App State

**Files:**
- Create: `src/state/appState.ts`
- Modify: `src/features/settings/SettingsPage.tsx`
- Modify: `src/api/tauri.ts`
- Modify: `src/App.tsx`
- Modify: `src/types.ts`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/models.rs`

- [x] **Step 1: Add backend settings command models**

Append to `src-tauri/src/models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettingsRequest {
    pub settings: AppSettings,
}
```

- [x] **Step 2: Add backend settings commands**

Add to `src-tauri/src/lib.rs`:

```rust
use models::{SaveCredentialRequest, SaveCredentialResponse, SaveSettingsRequest};
use state::AppPaths;
use tauri::State;

#[tauri::command]
fn load_app_settings(paths: State<'_, AppPaths>) -> AppResult<AppSettings> {
    settings::load_settings(&paths.settings_path)
}

#[tauri::command]
fn save_app_settings(paths: State<'_, AppPaths>, request: SaveSettingsRequest) -> AppResult<()> {
    settings::save_settings(&paths.settings_path, &request.settings)
}

#[tauri::command]
fn save_s3_secret(
    paths: State<'_, AppPaths>,
    request: SaveCredentialRequest,
) -> AppResult<SaveCredentialResponse> {
    credentials::save_secret(&paths.credential_fallback_dir, request)
}
```

Add `load_app_settings`, `save_app_settings`, and `save_s3_secret` to `generate_handler!`.

- [x] **Step 3: Add settings API wrappers**

Append to `src/api/tauri.ts`:

```ts
export interface AppSettings {
  profiles: S3ProfileSummary[];
  presets: Array<{
    id: string;
    name: string;
    targetFormat: string;
    quality: number;
    maxWidth: number;
    maxHeight: number;
    allowUpscale: boolean;
    removeGps: boolean;
  }>;
  namingTemplate: string;
  defaultOutputDir?: string;
  defaultProfileId?: string;
}

export interface SaveS3SecretRequest {
  profileId: string;
  secretAccessKey: string;
  allowInsecureFallback: boolean;
}

export const settingsApi = {
  loadSettings: () => invoke<AppSettings>("load_app_settings"),
  saveSettings: (settings: AppSettings) =>
    invoke<void>("save_app_settings", { request: { settings } }),
  saveS3Secret: (request: SaveS3SecretRequest) =>
    invoke<{ credentialRef: string; insecureFallbackUsed: boolean }>("save_s3_secret", { request }),
};
```

- [x] **Step 4: Create app state helper**

Create `src/state/appState.ts`:

```ts
import type { AppView, S3ProfileSummary } from "../types";

export interface GalleryFocus {
  profile?: S3ProfileSummary;
  prefix: string;
  highlightedKeys: string[];
}

export interface AppNavigationState {
  view: AppView;
  galleryFocus: GalleryFocus;
}

export const initialNavigationState: AppNavigationState = {
  view: "optimize",
  galleryFocus: {
    prefix: "",
    highlightedKeys: [],
  },
};
```

- [x] **Step 5: Update `App.tsx` to keep settings and gallery focus**

Replace simple `view` state with:

```tsx
const [navigation, setNavigation] = useState(initialNavigationState);
const [settings, setSettings] = useState<AppSettings>({
  profiles: [],
  presets: [],
  namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
});
```

Pass `navigation.galleryFocus` and `settings.profiles` to `S3GalleryPage`. Pass `settings`, the selected profile, and an `onUploadedToS3` callback to `OptimizePage`:

```tsx
const openGallery = (focus: GalleryFocus) => {
  setNavigation({ view: "gallery", galleryFocus: focus });
};
```

- [x] **Step 6: Make Settings edit one profile and core defaults**

Update `SettingsPage.tsx` to render a form with these exact labels:

```tsx
<label>
  Profile name
  <input defaultValue="Personal S3" />
</label>
<label>
  Endpoint
  <input placeholder="https://s3.example.com" />
</label>
<label>
  Region
  <input defaultValue="auto" />
</label>
<label>
  Bucket
  <input placeholder="my-image-bucket" />
</label>
<label>
  Access key ID
  <input />
</label>
<label>
  Secret access key
  <input type="password" />
</label>
<label>
  Allow local secret fallback
  <input type="checkbox" />
</label>
<label>
  Naming template
  <input defaultValue="{yyyy}/{mm}/{slug}-{hash}.{ext}" />
</label>
<label>
  Public Base URL
  <input placeholder="https://cdn.example.com" />
</label>
<label>
  Default prefix
  <input placeholder="images/2026/06" />
</label>
```

Add copy that says:

```tsx
<p>Secrets use system secure storage when available. Local fallback must be explicitly allowed.</p>
```

- [x] **Step 7: Verify and commit**

Run:

```bash
cd src-tauri
cargo test settings
cargo test credentials
cargo test
cd ..
pnpm test
pnpm build
```

Expected: Rust settings/credential tests, frontend tests, and build pass.

Commit:

```bash
git add src src-tauri/src
git commit -m "feat: add settings profiles and gallery focus state"
```

---

### Task 11: Direct Upload From Compression Results To S3 Gallery

**Files:**
- Modify: `src/features/optimize/OptimizePage.tsx`
- Modify: `src/features/gallery/S3GalleryPage.tsx`
- Modify: `src/types.ts`
- Modify: `src/api/tauri.ts`
- Modify: `src/features/optimize/OptimizePage.test.tsx`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/models.rs`

- [x] **Step 1: Add upload callback types**

Update `OptimizePage` props:

```ts
interface OptimizePageProps {
  onUploadedToS3?: (focus: {
    prefix: string;
    highlightedKeys: string[];
  }) => void;
  activeProfile?: S3ProfileSummary;
  namingTemplate: string;
}
```

- [x] **Step 2: Write transition test**

Update `OptimizePage.test.tsx`:

```tsx
vi.mock("../../api/tauri", async () => {
  return {
    uploadApi: {
      uploadObject: vi.fn(async (request: { objectKey: string }) => ({
        key: request.objectKey,
        size: 720_000,
        publicUrl: `https://cdn.example.com/${request.objectKey}`,
        isImage: true,
      })),
    },
  };
});

it("notifies parent after explicit Upload to S3", async () => {
  const user = userEvent.setup();
  const onUploadedToS3 = vi.fn();
  render(
    <OptimizePage
      activeProfile={{
        id: "p1",
        name: "Personal S3",
        bucket: "images",
        endpoint: "https://s3.example.com",
        region: "auto",
        defaultPrefix: "2026/06",
        publicBaseUrl: "https://cdn.example.com",
      }}
      namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}"
      onUploadedToS3={onUploadedToS3}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Compress" }));
  await user.click(screen.getByRole("button", { name: "Upload to S3" }));

  expect(onUploadedToS3).toHaveBeenCalledWith({
    prefix: "2026/06",
    highlightedKeys: ["2026/06/photo-01-sample.webp"],
  });
});
```

- [x] **Step 3: Add upload API wrapper**

Append to `src/api/tauri.ts`:

```ts
export interface UploadObjectRequest {
  profile: S3ProfileSummary;
  sourcePath: string;
  objectKey: string;
  contentType?: string;
}

export const uploadApi = {
  uploadObject: (request: UploadObjectRequest) =>
    invoke<GalleryObject>("upload_gallery_object", { request }),
};
```

- [x] **Step 4: Implement explicit real upload action**

In the result screen, make `Upload to S3` compute object keys from the active profile prefix and compressed output filenames, call `uploadApi.uploadObject` once per compressed item, then notify the parent with returned keys:

```ts
const uploadToS3 = async () => {
  if (!activeProfile) {
    setResultError("Configure and select an S3 profile before uploading.");
    return;
  }
  const prefix = activeProfile.defaultPrefix || "images";
  const uploaded = await Promise.all(
    compressedItems.map((item) => {
      const outputFileName = item.outputFileName ?? "image.webp";
      const objectKey = `${prefix.replace(/\/$/, "")}/${outputFileName}`;
      return uploadApi.uploadObject({
        profile: activeProfile,
        sourcePath: item.outputPath ?? item.sourcePath,
        objectKey,
        contentType: contentTypeFor(item.settings.targetFormat),
      });
    }),
  );
  onUploadedToS3?.({
    prefix,
    highlightedKeys: uploaded.map((object) => object.key),
  });
};
```

Add this helper in `OptimizePage.tsx`:

```ts
function contentTypeFor(format: string) {
  switch (format) {
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "heif":
      return "image/heif";
    default:
      return "application/octet-stream";
  }
}
```

- [x] **Step 5: Make S3 Gallery highlight uploaded keys**

Update `S3GalleryPage` props:

```ts
interface S3GalleryPageProps {
  focus?: {
    prefix: string;
    highlightedKeys: string[];
  };
}
```

Render highlighted cards with class `highlighted`.

- [x] **Step 6: Add highlight style**

Append to `src/App.css`:

```css
.object-card.highlighted {
  border-color: #1f7a4d;
  box-shadow: 0 0 0 2px rgba(31, 122, 77, 0.15);
}
```

- [x] **Step 7: Verify and commit**

Run:

```bash
pnpm test -- src/features/optimize/OptimizePage.test.tsx
pnpm test
pnpm build
cd src-tauri
cargo check
cd ..
```

Expected: explicit upload transition test passes, upload API types compile, and no auto-upload behavior exists.

Commit:

```bash
git add src
git commit -m "feat: connect optimizer upload action to gallery"
```

---

### Task 12: End-To-End Verification And Documentation

**Files:**
- Modify: `README.md`
- Optional Modify: `docs/superpowers/plans/2026-06-26-pic-piper-implementation.md` checkbox statuses only during execution.

- [x] **Step 1: Update README**

Replace starter README with:

```md
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
```

- [x] **Step 2: Run full frontend verification**

Run:

```bash
pnpm test
pnpm build
```

Expected: frontend tests and TypeScript/Vite build pass.

- [x] **Step 3: Run full Rust verification**

Run:

```bash
cd src-tauri
cargo test
cargo fmt --check
cd ..
```

Expected: Rust tests pass and formatting is clean.

- [x] **Step 4: Run Tauri dev smoke test**

Run:

```bash
pnpm tauri dev
```

Expected: desktop window opens with Pic Piper navigation. Manually verify:

- Optimize page has only `Apply preset` and `Compress` as edit-screen primary actions.
- Compression results show `Save to local folder`, `Upload to S3`, and `Back to edit settings`.
- No auto-upload control exists.
- S3 Gallery has no rename or move controls.

- [x] **Step 5: Commit docs**

Commit:

```bash
git add README.md
git commit -m "docs: describe Pic Piper development scope"
```

---

## Self-Review

Spec coverage:

- GUI-first Tauri app: Tasks 1-2.
- Three entries `Optimize`, `S3 Gallery`, `Settings`: Tasks 1-2.
- Per-image compression settings and quality/size exploration: Tasks 2, 5, 6.
- Compression result actions only after `Compress`: Tasks 6 and 11.
- No auto-upload or standalone queue: Tasks 6, 11, and 12 verification.
- S3 Gallery CRUD minus rename/move: Tasks 7-9.
- Public Base URL joining and missing-base error: Task 7.
- Generic S3-compatible profile foundations: Tasks 3, 4, 9, 10.
- Local upload history model and settings persistence: Tasks 3 and 10.
- Testing layers: frontend Vitest in Tasks 1, 2, 6, 8, 11; Rust tests in Tasks 3, 4, 5, 7, 9.

Verification note:

- Full MinIO integration tests can be added after Task 9 if real S3 credentials are unavailable locally, but the first implementation still wires `Upload to S3` to the real backend upload command.
