# Copy-Paste Prompt For A Fresh Agent

You are working in `/Users/frankwei/Code/DesktopApp/pic-piper`.

Follow these repository rules:

- Use `PIC_PIPER_NO_KEYCHAIN=1` for tests/builds that may touch Tauri settings or credentials.
- Do not revert unrelated dirty files.
- Preserve product boundaries: no auto-upload, no standalone queue page, no gallery rename/move, no resize controls.
- Use focused regression tests before fixes.
- Keep commits scoped and conventional.

Read these files first:

- `AGENTS.md`
- `docs/superpowers/specs/2026-06-27-code-quality-remediation-design.md`
- `docs/superpowers/plans/2026-06-27-code-quality-remediation-implementation.md`

Your task is to implement the assigned task group from the implementation plan exactly. Do not broaden scope. If you discover an issue not listed in the plan, write it down and continue unless it blocks your assigned task.

Required verification for your assigned task:

```bash
PIC_PIPER_NO_KEYCHAIN=1 pnpm test
PIC_PIPER_NO_KEYCHAIN=1 pnpm build
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo test
cd src-tauri && PIC_PIPER_NO_KEYCHAIN=1 cargo fmt --check
```

If the full suite is too slow while iterating, run targeted tests first, then run the full suite before claiming completion.

Report back with:

- Files changed.
- Tests added.
- Commands run and pass/fail status.
- Any unresolved risk or follow-up.

Suggested task ownership:

- Agent A: credentials hardening, object key/URL normalization, atomic settings/history writes.
- Agent B: no-overwrite saves/downloads, S3 pagination, optimizer cache/resource cleanup.
- Agent C: metadata semantics, duplicate compression dispatch, partial upload retry, accurate API/format types.
- Agent D: delete/history error visibility, multi-profile state repair, UI/accessibility cleanup.
- Main integrator: final regression coverage, conflict resolution, full verification.
