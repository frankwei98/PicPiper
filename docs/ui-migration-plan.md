# UI Migration Plan — Tailwind v4 + Base UI

## Status: Scaffolding complete, ready for component migration

The Tailwind v4 + Base UI foundation is wired up and verified (`pnpm build` + `pnpm test` green). This document is the hand-off plan for migrating the existing hand-written CSS components to Tailwind utilities + Base UI primitives, while enforcing the `baseline-ui` constraints.

---

## What is already done (do NOT redo)

1. **Dependencies installed**
   - `tailwindcss@4.3.1`, `@tailwindcss/vite@4.3.1` (dev)
   - `tw-animate-css@1.4.0` (dev) — entrance/micro-animation utilities
   - `@base-ui/react@1.6.0` (runtime) — headless primitives
   - `clsx@2.1.1`, `tailwind-merge@3.6.0` (runtime) — for `cn`

2. **Vite plugin wired** — `vite.config.ts` imports `@tailwindcss/vite` and adds it to `plugins`.

3. **Theme bridge** — `src/styles/theme.css`
   - `@import "tailwindcss"` + `@import "tw-animate-css"`
   - `@theme inline { … }` exposes every existing CSS variable from `App.css` as Tailwind tokens:
     - Colors: `--color-surface`, `--color-primary`, `--color-on-surface-variant`, `--color-error-container`, … (so `bg-surface`, `text-primary`, `border-outline-variant` resolve to the design system)
     - Radius: `--radius-xs … --radius-2xl`, `--radius-full` (so `rounded-md`, `rounded-lg`, …)
     - Spacing: `--spacing-xs … --spacing-2xl` (so `p-lg`, `gap-md`, `m-xl`, …)
     - Font sizes: `--text-large-title`, `--text-title-2`, `--text-headline`, `--text-body`, `--text-callout`, `--text-footnote`, `--text-caption` (so `text-body`, `text-title-2`, …)
     - Font family: `--font-sans`
   - Global `prefers-reduced-motion` guard kept here as the source of truth.

4. **CSS load order** — `src/main.tsx` imports `./styles/theme.css` **before** `App` (which imports `./App.css`). Tailwind base layers come first; design-system `:root` variables from `App.css` resolve at runtime via `var()` references (`@theme inline` keeps them as `var(--…)` rather than inlining literal values).

5. **`cn` utility** — `src/utils/cn.ts` (`clsx` + `tailwind-merge`).

6. **Base UI wrappers** — `src/components/ui/Dialog.tsx` exports:
   - `AlertDialog` — styled wrapper over `@base-ui/react/alert-dialog` (focus trap, Escape, focus return, `role="alertdialog"` all handled by Base UI). Props: `open`, `onOpenChange`, `title`, `description`, `confirmLabel`, `cancelLabel`, `onConfirm`, `onCancel`, `className`.
   - `Dialog` — styled wrapper for non-destructive dialogs (same popup chrome, free-form children). Props: `open`, `onOpenChange`, `title`, `children`, `className`.

---

## Migration rules (enforce on every change)

From `AGENTS.md` + `baseline-ui` skill. Non-negotiable:

- **Tailwind defaults only** — do not invent arbitrary values (`z-[999]`, `p-[13px]`). Use the tokens exposed in `theme.css`. If a value is genuinely missing, add it to `@theme inline` first.
- **`cn` for class logic** — never string-concatenate conditional classes; use `cn("base", condition && "extra")`.
- **Base UI for keyboard/focus surfaces** — dialogs, menus, selects, sliders, tabs, tooltips, switches, checkboxes. Never hand-roll focus traps, Escape handlers, or `role`/`aria-modal` again.
- **`aria-label` on icon-only buttons.**
- **`AlertDialog` for destructive/irreversible actions.**
- **`h-dvh` not `h-screen`** (and `100dvh` in any raw CSS).
- **`safe-area-inset`** on fixed elements (`pt-[max(theme(spacing.xl),env(safe-area-inset-top))]` or the equivalent).
- **Errors next to the action**, not in a distant banner.
- **Never block paste** in inputs/textareas.
- **Animation**: only `transform` + `opacity`; ≤200ms for feedback; `ease-out` entrances; no custom easing curves; no looping animation without an off-screen pause; respect `prefers-reduced-motion` (global guard already in place).
- **Typography**: `text-balance` on headings, `text-pretty` on body, `tabular-nums` on data.
- **Layout**: fixed `z-index` scale via tokens (do not introduce arbitrary `z-*`); `size-*` for squares.
- **Design**: no gradients unless explicitly requested; no purple/multicolor gradients; no glow as primary affordance; default shadow scale only; empty states must have one clear next action; one accent color per view (primary = the single accent).

---

## Migration tasks

Work top-down. After each task run:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test
PIC_PIPER_NO_KEYCHAIN=1 pnpm build
```

Both must stay green before moving on. Do not commit unless asked.

### Task 1 — Replace hand-built `AlertDialog.tsx` with the Base UI wrapper

**Files:** `src/components/AlertDialog.tsx` (delete), `src/features/gallery/S3GalleryPage.tsx`, `src/features/settings/SettingsPage.tsx`

- Delete `src/components/AlertDialog.tsx` (the hand-built one).
- Update imports in both pages: `import { AlertDialog } from "./components/ui/Dialog"` (note: the new wrapper lives at `src/components/ui/Dialog.tsx`).
- The new `AlertDialog` takes `onOpenChange(open: boolean)` instead of being open/close only. Wire `onOpenChange={(open) => !open && setDeleteTarget(null)}` (or the preset equivalent) so Escape + backdrop click close it.
- Verify the existing tests still pass — they query `findByRole("alertdialog")` and click `Cancel`/`Delete` inside it. Base UI renders `role="alertdialog"` with `aria-modal`, and `Close` triggers are real buttons, so the tests should pass unchanged. If a label mismatch appears, adjust the `confirmLabel`/`cancelLabel` props to match the test's `name` regex (current tests use `/delete/i` and `/cancel/i`).

### Task 2 — Replace the preset `Dialog` in `SettingsPage` with Base UI `Dialog`

**Files:** `src/features/settings/SettingsPage.tsx`, `src/components/ui/Dialog.tsx`

- Remove the hand-rolled `presetDialogRef`, the `useEffect` Escape handler, the `useEffect` focus handler, the `tabIndex={-1}` and the `<div className="modal-backdrop">` + `<section className="modal-dialog">` JSX.
- Replace with `<Dialog open={isPresetDialogOpen} onOpenChange={(open) => !open && closePresetDialog()} title={editingPreset ? "Edit preset" : "Add preset"}> …form… </Dialog>`.
- Move the "Close" button out of the header into a `Dialog.Close` (import `AlertDialog.Close` from `@base-ui/react/alert-dialog` — the `Dialog` wrapper does not expose Close; either add a `Close` export to `Dialog.tsx` or render a plain button calling `closePresetDialog`). Pick one and keep it consistent.
- Keep the form `onSubmit` behavior identical.
- Confirm `SettingsPage.test.tsx` still passes (it does not currently assert on the preset dialog's keyboard behavior, only on preset add/edit/delete flows + the new AlertDialog confirm).

### Task 3 — Add Base UI primitives for the remaining interactive surfaces

Migrate these to Base UI so no hand-rolled keyboard/focus behavior remains:

| Surface | Current | Base UI primitive |
|---|---|---|
| Nav buttons | `Layout.tsx` plain `<button>` with `active` class | `@base-ui/react` `Tabs` (vertical) **or** keep as styled `<button>` — nav is single-select, `Tabs.Root` + `Tabs.Tab` gives arrow-key nav + `aria-selected`. Recommended: `Tabs`. |
| Profile `<select>` (Gallery) | native `<select>` | `@base-ui/react/select` — typeahead, keyboard, focus trap inside listbox. |
| Preset `<select>` (Optimize header) | native `<select>` | same. |
| Target format `<select>` (preset form) | native `<select>` | same. |
| Quality `<input type="range">` (per image + preset form) | native range | `@base-ui/react/slider` — keyboard arrows, accessible value label. |
| `<input type="checkbox">` (remove GPS, insecure fallback) | native checkbox | `@base-ui/react/checkbox` — proper `indeterminate` + focus ring. |
| `<input type="number">` (preset quality) | native number | `@base-ui/react/number-field` — spin buttons, keyboard clamp. |
| `copyMessage` toast | inline `<p>` | `@base-ui/react/toast` — auto-dismiss, region landmark. |

For each: create a thin styled wrapper in `src/components/ui/<Name>.tsx` (e.g. `Select.tsx`, `Slider.tsx`, `Checkbox.tsx`, `NumberField.tsx`, `Toast.tsx`) so call sites stay clean and the styling lives in one place. Match the existing visual style from `App.css` (`rounded-md`, `border-outline-variant`, `bg-surface-container`, focus ring = `ring-2 ring-primary/20`).

### Task 4 — Convert `Layout.tsx` to Tailwind utilities

**File:** `src/components/Layout.tsx`

Replace `className="app-shell"`, `sidebar`, `sidebar-brand`, `sidebar-brand-icon`, `nav-button`, `nav-icon` with Tailwind utility classes via `cn`. Map the structure from `App.css` lines 206-319. Keep the responsive `@media (max-width: 760px)` behavior using Tailwind's `md:`/`lg:` breakpoints (760px ≈ `sm`/`md` — use `md:` and verify the breakpoint matches; if not, set `--breakpoint-md: 760px` in `theme.css`).

Add `aria-label` to the brand icon (currently `🎵` with no label) and ensure nav buttons have accessible names (they do — text label present).

### Task 5 — Convert `OptimizePage.tsx` to Tailwind utilities

**File:** `src/features/optimize/OptimizePage.tsx`

- `page-stack`, `page-header`, `header-actions`, `drop-zone`, `item-list`, `image-row`, `image-row__thumb`, `image-row__meta`, `result-summary`, `result-actions` → utilities.
- Replace inline `style={{ background: "var(--surface-container-high)" }}` skeleton hacks with `bg-surface-container-high` classes (the unstaged work added these inline; convert to utilities).
- Keep the structural skeleton loading state (already added) — ensure it uses `aria-label="Loading"` and the skeleton blocks have `aria-hidden`.
- Add `tabular-nums` to byte/percentage displays (the unstaged CSS rule does this globally for `.image-row p` — when you remove that CSS, add `tabular-nums` utility directly on the elements).
- `text-balance` on `h2`, `text-pretty` on the subtitle `<p>` and image-row meta `<p>`.
- Icon-only remove button already has `aria-label` — keep it.

### Task 6 — Convert `S3GalleryPage.tsx` to Tailwind utilities

**File:** `src/features/gallery/S3GalleryPage.tsx`

- `gallery-toolbar`, `gallery-grid`, `object-card`, `object-thumb`, `object-thumb-img`, `thumb-fallback`, `object-actions` → utilities.
- Replace inline skeleton `style` with utility classes.
- Empty states: keep the "Add a profile in Settings" and "Upload local images" next-action buttons (already added). Ensure they are `btn-primary`-styled via utilities.
- `tabular-nums` on object size/key data.
- `text-pretty` on object key `<p>`.
- Replace native `<select>` (profile) and `<input>` (prefix, search) per Task 3.
- The image `onError` fallback toggling `display: none` + rewriting `thumb-fallback` textContent is fragile — replace with a Base UI pattern or a simple stateful `<img>` component that swaps to a fallback on error. Keep behavior: broken image → "Image"/"File" text.

### Task 7 — Convert `SettingsPage.tsx` to Tailwind utilities

**File:** `src/features/settings/SettingsPage.tsx`

- `settings-grid`, `panel`, `panel-header`, `profile-form`, `preset-list`, `preset-item`, `preset-item-actions`, `preset-form-actions` → utilities.
- Replace native inputs per Task 3 (checkbox, number-field, select, text inputs stay as styled `<input>` with utility classes + focus ring).
- The "Allow local secret fallback" warning + the "Secrets use system secure storage" note: keep adjacent to the relevant control (they already are). `text-pretty` on the warning paragraph.
- `tabular-nums` on preset quality percentage display.

### Task 8 — Retire `App.css`

**File:** `src/App.css`

Once Tasks 4-7 are done and no component imports a class from `App.css`:

1. Move the `:root` + `@media (prefers-color-scheme: light)` variable definitions into `src/styles/theme.css` (above the `@theme inline` block, as plain `:root { … }` so they remain runtime CSS variables that the Tailwind tokens reference via `var()`).
2. Delete `src/App.css`.
3. Remove the `import "./App.css"` line from `src/App.tsx`.
4. Confirm `pnpm build` still produces a stylesheet with all variables + Tailwind utilities.

Keep these CSS-only bits that have no Tailwind equivalent:
- The `:root` color/surface token definitions (light + dark) — these are the source of truth the `@theme inline` block points at.
- `::selection` styling (or replace with Tailwind `selection:` variant on a root element).
- Custom scrollbar styling (`::-webkit-scrollbar*`) — keep as raw CSS in `theme.css` (no Tailwind equivalent).
- `color-scheme: dark/light` — keep in the `:root` blocks.

### Task 9 — Final baseline-ui audit

Re-run the full audit against the migrated code:

- `grep -rn "h-screen\|100vh" src/` → expect zero hits.
- `grep -rn "cubic-bezier" src/` → expect zero hits (Base UI uses its own internal motion; our wrappers use `ease-out`).
- `grep -rn "window.confirm" src/` → expect zero hits.
- `grep -rn "backdrop-filter\|blur(" src/` → expect zero hits (removed in unstaged work; do not reintroduce).
- `grep -rn "linear-gradient" src/` → expect zero hits.
- `grep -rn "letter-spacing\|tracking-" src/` → expect zero hits unless explicitly requested.
- `grep -rn "transition: all\|transition-all" src/` → expect zero hits.
- `grep -rn "z-\[" src/` → expect zero arbitrary z-indexes.
- `grep -rn "will-change" src/` → only inside active animation components.
- Verify every icon-only button has `aria-label`.
- Verify every destructive action opens `AlertDialog`.
- Verify `prefers-reduced-motion` global block exists in `theme.css`.

Run the verification commands from `AGENTS.md`:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test
PIC_PIPER_NO_KEYCHAIN=1 pnpm build
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo fmt --check
```

---

## Notes for the executor

- **Do not introduce new dependencies.** Everything needed is installed.
- **Do not change Rust/Tauri code** in this pass — pure frontend migration.
- **Do not change test assertions unless a Base UI role/label mismatch forces it.** If a test breaks because Base UI renders a different role, prefer adjusting the wrapper's props/labels to match the existing assertion intent, not the other way around.
- **Keep the unstaged work.** The unstaged diff already fixes the worst `baseline-ui` MUST violations (100dvh, AlertDialog for delete, reduced-motion, no gradients, scoped transitions, tabular-nums, text-wrap, skeleton loading, empty-state actions, single accent). Build on top of it; do not revert.
- **One task per commit** (conventional commit style: `refactor(ui): …`, `feat(ui): …`). Run the verification commands before each commit.
- **`cn` is mandatory** for any conditional class logic from here on.
- **Tailwind v4 has no `tailwind.config.js`** — all config is CSS-first via `@theme` in `theme.css`. To add a token, append to the `@theme inline` block (for `var()` references) or a plain `@theme` block (for literal values).
- **Breakpoint note:** existing CSS uses `760px` and `820px` media queries. Tailwind v4 defaults are `sm:640`, `md:768`, `lg:1024`. If exact parity matters, add `--breakpoint-md: 760px;` and `--breakpoint-lg: 820px;` to `@theme inline` in `theme.css`. Otherwise use the closest default and visually verify.

## File map after migration

```
src/
├── main.tsx                      # imports theme.css
├── styles/
│   └── theme.css                 # tailwind + tw-animate-css + @theme tokens + :root vars + scrollbar/selection CSS
├── utils/
│   └── cn.ts                     # clsx + tailwind-merge
├── components/
│   ├── Layout.tsx                # Tailwind utilities
│   └── ui/
│       ├── Dialog.tsx            # AlertDialog + Dialog (Base UI wrappers)
│       ├── Select.tsx            # Base UI Select wrapper         (Task 3)
│       ├── Slider.tsx            # Base UI Slider wrapper         (Task 3)
│       ├── Checkbox.tsx          # Base UI Checkbox wrapper       (Task 3)
│       ├── NumberField.tsx       # Base UI NumberField wrapper    (Task 3)
│       └── Toast.tsx             # Base UI Toast wrapper          (Task 3)
├── features/
│   ├── optimize/OptimizePage.tsx
│   ├── gallery/S3GalleryPage.tsx
│   └── settings/SettingsPage.tsx
└── App.css                       # deleted in Task 8
```
