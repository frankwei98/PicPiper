# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the TypeScript UI.
- `src/features/optimize`, `src/features/gallery`, and `src/features/settings` hold feature screens and their tests.
- `src/api/tauri.ts` defines frontend command wrappers for Tauri calls.
- `src/types.ts` contains shared frontend domain types.
- `src-tauri/src/` contains Rust commands and domain modules such as `optimizer.rs`, `gallery.rs`, `credentials.rs`, and `settings.rs`.
- `src-tauri/capabilities/default.json` controls Tauri plugin permissions.
- `public/` and `src-tauri/icons/` hold static assets.

## Build, Test, and Development Commands

- `pnpm dev`: run the Vite frontend dev server.
- `pnpm tauri dev`: run the desktop app in development mode.
- `pnpm test`: run Vitest frontend/unit tests.
- `pnpm build`: type-check with `tsc` and build the Vite frontend.
- `cd src-tauri && cargo test`: run Rust unit tests.
- `cd src-tauri && cargo fmt --check`: verify Rust formatting.

## Coding Style & Naming Conventions

Use TypeScript with React function components and hooks. Keep feature-specific UI, tests, and helpers near the feature directory. Use PascalCase for components, camelCase for functions and variables, and descriptive test names.

Rust code follows standard `rustfmt` style. Keep serializable API structs in `models.rs`, Tauri command wiring in `lib.rs`, and domain behavior in focused modules.

## Testing Guidelines

Frontend tests use Vitest with Testing Library and live beside feature files as `*.test.tsx`. Prefer behavior tests for user-visible flows such as choosing images, applying presets, compressing, and uploading.

Rust tests live in module-local `#[cfg(test)]` blocks. Add regression tests for optimizer behavior, S3 object handling, credential storage, and naming logic when changing those areas.

Before handing off changes, run:

```bash
pnpm test
pnpm build
cd src-tauri && cargo test
cd src-tauri && cargo fmt --check
```

## Commit & Pull Request Guidelines

Follow the existing concise Conventional Commit style: `feat: ...`, `fix: ...`, or `style: ...`. Keep commits scoped to one behavior or cleanup.

Pull requests should include a short summary, screenshots or recordings for UI changes, notes for S3/R2 credential behavior, and the verification commands run. Do not include real S3 credentials or secrets in commits, logs, screenshots, or tests.

## Security & Configuration Tips

S3 secrets are stored locally on this device and should not be treated as secure shared storage. Avoid logging secret access keys, presigned credentials, or bucket test tokens.
