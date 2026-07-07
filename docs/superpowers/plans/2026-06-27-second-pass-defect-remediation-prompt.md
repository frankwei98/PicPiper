# Copy-Paste Prompt: Pic Piper Second-Pass Defect Remediation

You are working in `/Users/frankwei/Code/DesktopApp/pic-piper`.

Read first:

- `AGENTS.md`
- `docs/superpowers/specs/2026-06-27-second-pass-defect-remediation-design.md`
- `docs/superpowers/plans/2026-06-27-second-pass-defect-remediation-implementation.md`

Implement the assigned task group only. Do not broaden scope and do not revert unrelated changes.

Product constraints:

- No auto-upload.
- No standalone queue page.
- No gallery rename/move.
- No image resize controls.
- Do not implement true EXIF preservation in this pass.

Workflow:

1. Inspect the current code for your assigned files.
2. Write regression tests first.
3. Run the targeted tests and confirm they fail for the intended reason.
4. Implement the smallest fix.
5. Run targeted tests again.
6. Run full verification before claiming completion.
7. Commit only your task files with a concise Conventional Commit message.

Required final verification:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test
PIC_PIPER_NO_KEYCHAIN=1 pnpm build
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo fmt --check
```

Suggested parallel ownership:

- Agent A: Tasks 1, 7, 11.
- Agent B: Tasks 2, 8, 9, 10.
- Agent C: Tasks 3, 4, 5, 6.
- Main integrator: resolve conflicts and run final verification.

Report back with:

- Task numbers completed.
- Files changed.
- Tests added.
- Verification commands and results.
- Any remaining risk.
