# UI localization

`en.json` defines the typed message keys and English fallback. Each supported locale has the same keys in `locales/`. Translate values only; preserve `{{placeholders}}`, format names, URL examples and naming tokens. Use whole sentences with interpolation so translators can reorder values. `t()` returns plain text; React handles escaping.

React views call `useLocale()` to subscribe to language changes and `t()` to render messages. Non-React callbacks can call `t()` directly. Do not translate at module initialization or use translated strings as identifiers, status checks, paths or backend payload values. Keep backend diagnostic details intact; localize application-owned fallback messages.

The language selector in Settings applies immediately without saving an S3 profile. Preferences live in `localStorage` under `pic-piper.language`; `system` follows the browser/webview language list. Regional variants use their supported base language, including all Chinese variants falling back to Simplified Chinese for now. Unsupported languages fall back to English. The HTML `lang` attribute tracks the active locale. Storage failures leave the session choice usable.

To add a language, add a complete JSON catalog, register it in `index.ts`, and run `pnpm test` and `pnpm build:web`. Catalog tests check key and interpolation parity. Existing backend/native OS messages are outside this frontend catalog; raw backend error details and image diagnostics may still be in English. Transient messages already produced by an operation retain their language until replaced.
