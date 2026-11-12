import { useSyncExternalStore } from "react";
import en from "./locales/en.json";

export type MessageKey = keyof typeof en;
export type Catalog = Record<MessageKey, string>;
export const languages = [
  { id: "zh-CN", label: "简体中文" },
  { id: "en", label: "English" },
  { id: "fr", label: "Français" },
  { id: "es", label: "Español" },
  { id: "ja", label: "日本語" },
  { id: "ko", label: "한국어" },
] as const;
export type Locale = (typeof languages)[number]["id"];
export type LanguagePreference = Locale | "system";
const storageKey = "pic-piper.language";
const catalogs: Record<Locale, Catalog> = { en, "zh-CN": en, fr: en, es: en, ja: en, ko: en };

export function resolveLocale(preferred: readonly string[]): Locale {
  for (const language of preferred) {
    const base = language.toLowerCase().split(/[-_]/)[0];
    const found = languages.find(({ id }) => id.toLowerCase().split("-")[0] === base);
    if (found) return found.id;
  }
  return "en";
}
function readPreference(): LanguagePreference {
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (languages.some(({ id }) => id === saved)) return saved as Locale;
  } catch { /* Storage may be unavailable in a restricted webview. */ }
  return "system";
}
let preference = readPreference();
let locale: Locale;
const listeners = new Set<() => void>();
function updateLocale() {
  locale = preference === "system" ? resolveLocale(navigator.languages?.length ? navigator.languages : [navigator.language]) : preference;
  document.documentElement.lang = locale;
  for (const listener of listeners) listener();
}
updateLocale();
export function setLanguage(next: LanguagePreference) {
  preference = next;
  try { window.localStorage.setItem(storageKey, next); } catch { /* Keep the in-memory choice. */ }
  updateLocale();
}
export function getLanguagePreference() { return preference; }
export function getLocale() { return locale; }
export function useLocale() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => `${preference}:${locale}`);
}
window.addEventListener("languagechange", () => { if (preference === "system") updateLocale(); });
window.addEventListener("storage", (event) => {
  if (event.key === storageKey || event.key === null) { preference = readPreference(); updateLocale(); }
});

/** Whole-message interpolation; values remain plain text and React escapes them. */
export function t(key: MessageKey, values: Record<string, string | number> = {}): string {
  const template = catalogs[locale][key] || en[key];
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : placeholder,
  );
}
export function imageCount(count: number) {
  return t(new Intl.PluralRules(locale).select(count) === "one" ? "{{count}} image" : "{{count}} images", { count });
}
