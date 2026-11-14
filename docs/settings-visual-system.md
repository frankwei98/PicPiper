# Settings visual system

Status: approved and implemented, 2026-11-14. The shared preference-row component and typography/control tokens apply the reviewed design to the production settings interface.

## Audit before implementation

| Finding | Current source | Effect |
| --- | --- | --- |
| Field names are 12px, medium weight and muted; hints are 11px in the same color. | `src/styles/theme.css:1077`, `:1081` | Essential field names look like supporting text. |
| Normal fields use a vertical grid; switches use a horizontal flex row. | `src/styles/theme.css:1076`, `:1082`; `SettingsPage.tsx` language and close-behavior fields | Select controls fall below their labels while switches remain on the right. |
| Controls use three heights: 32px selects, 34px settings text inputs and 36px Mini quality inputs. | `src/components/ui/native-select.tsx:27`; `src/styles/theme.css:1078`; `src/features/mini/mini.css:92` | Peer controls have different geometry. |
| Group headings repeat individual setting names. | `SettingsPage.tsx` Window behavior / Close window behavior and Status bar icon / Show status bar icon | Extra hierarchy competes with the actual field title. |
| OAuth paragraphs use a broad 13px rule, settings hints use 11px, and Mini hints use 12px. | `src/styles/theme.css:1177`, `:1081`; `src/features/mini/mini.css:85` | Supporting text can be larger than field names. The OAuth paragraph rule also reaches nested hints. |

## Tokens

| Role | Size / weight | Color |
| --- | --- | --- |
| Page title | 20px / 600 | Foreground |
| Section heading | 12px / 500 | Secondary foreground |
| Setting or form-field title | 14px / 500 | Foreground |
| Control value and action | 14px / 400–500 | Foreground |
| Description and status | 12px / 400 | Secondary foreground |
| Validation error | 12px / 400 | Destructive |

Selects, text inputs and number inputs use a shared 36px height, 8px corner radius, one border token, and one focus ring. Switches retain their native compact dimensions and align to the same right edge. Disabled controls dim the value/control only; the setting title remains legible at the normal title style.

The selected sidebar item retains its white light-theme surface, neutral text, thin border and subtle shadow. The dark theme uses its corresponding raised surface. Product blue remains the action color. App/Dock icons keep the supplied black-tile color crocodile in both themes. The main title bar uses the monochrome crocodile in the theme foreground; the status bar uses it as a native template. Mini and onboarding retain their color logo.

## Row patterns

**Preference row:** a left column containing a title and optional description; a right column containing the select, switch or small number input. Align control centers with the title/description block. Keep the control in the right column at the supported desktop minimum width. Selects use a consistent 232px width; a number field may be shorter while sharing the right edge. Descriptions can wrap. A dropdown does not move beneath its label.

The settings content fills the window width remaining after the sidebar. Controls and Save align to the viewport's right content inset, including wide windows; the content must not stop at an 850px maximum width. Keep the existing 28px desktop inset (22px at the smaller desktop breakpoint).

General uses this pattern for language, closing the window, showing the status icon, image format and image quality. Profile selectors, path-style addressing, and the default-profile switch use it too.

**Long-text form field:** a visible 14px foreground label above a full-width text field. Connection details, credentials, public URLs, prefixes and naming templates use this pattern so long values remain editable. They share the same control geometry and text hierarchy as preference rows. Short related fields can share a two-column grid.

Use section titles only for meaningful groups such as Preferences, Quick compression, Connection and Credentials. Remove the repeated Window behavior heading above Close window behavior. Put the status-icon toggle and its format/quality rows in one Quick compression group.

## Behavior retained in the design

- General includes Mini; there is no separate Mini settings category.
- Closing the main window defaults to quitting. Background operation can be chosen independently.
- Enabling the status icon shows a disabled background choice and its explanation. The personal preference survives; disabling the icon restores it.
- Compression defaults remain WEBP / 90%, followed by copying image content. Upload remains an explicit action in Mini.
- Language changes apply immediately; other General changes use Save general settings.
- Side navigation remains grouped into Application and Cloud storage.

## Implementation

- `src/components/ui/preference-row.tsx` owns the left title/description and right control layout. Both the title and the visible control are labels for the native input, preserving clickable switches and focus behavior.
- `src/styles/theme.css` owns the shared `--preference-*` size tokens, right alignment, long-form field styles, error typography and responsive columns. Existing controls supply their native keyboard and focus behavior.
- General and the Mini defaults use preference rows. S3 profile selectors, path-style/default-profile switches, and provider account/jurisdiction selectors use the same layout. Long text keeps a foreground label above its input. The original stacked Mini form remains available to OOBE.
- The navigation and page heading use **One-click authorization / 一键授权**. Cloudflare R2 is named inside its provider section, so additional provider sections can share the category without renaming it. The current browser authorization and credential behavior remains Cloudflare R2's existing flow.
- Behavior coverage includes provider-neutral navigation, preserved authorization cancellation, switching and restoring the close preference, saving General without an S3 profile, and clicking the visible switch control. Native smoke also measures title/description fonts, control heights and right-column geometry for all six languages at the minimum desktop size.

## Validation

- Frontend: 28 files / 237 tests passed. Web and macOS builds passed.
- Go tests, full race checks, isolated modern-codec concurrent-first-use check, vet, gofmt and `git diff --check` passed.
- Full native smoke passed in `build/smoke-X7xxJG/report.json`, including six-language preference-row geometry, shared 20px vertical row padding, typography/control sizes, close-window behavior, Mini, S3, clipboard and URL restoration. The system-rendered app-icon check passed too.
- Inspected the native Chinese General screenshot, French minimum-size layout and S3 form in that report directory. Inspected the unchanged provider page in `build/smoke-tEzd4K/account-authorization.png`: generic category heading, explicit Cloudflare R2 provider and right-aligned browser sign-in action. Real-provider authorization was not performed.

Wide-window correction, 2026-11-14:

- The earlier 850px content cap placed controls in the middle of wide windows. Removed that cap so the settings column fills the remaining viewport width.
- Added a native regression against the viewport's actual right content inset, measuring visible selects, switches, quality input and Save rather than only their position relative to labels. It failed on the capped layout in `build/smoke-fOtel4/report.json` and passed after the CSS correction.
- Full native smoke passed in `build/smoke-W44sea/report.json`, including English/Chinese at 1920px, Chinese at 1120px and all six languages at 920px. Inspected both wide General screenshots. Frontend tests (237), web/macOS builds, Go/race/codec checks, vet, formatting and `git diff --check` passed.
