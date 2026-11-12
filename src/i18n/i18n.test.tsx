import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { getLanguagePreference, getLocale, imageCount, resolveLocale, setLanguage, t, languages } from ".";
import { Layout } from "@/components/Layout";
import { SettingsPage } from "@/features/settings/SettingsPage";
import userEvent from "@testing-library/user-event";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    clear: () => values.clear(),
  });
});
afterEach(() => { act(() => setLanguage("en")); vi.unstubAllGlobals(); });

describe("language preferences", () => {
  it("matches regional locales in preference order and falls back to English", () => {
    expect(resolveLocale(["de-DE", "fr-CA", "en-US"])).toBe("fr");
    expect(resolveLocale(["zh-TW"])).toBe("zh-CN");
    expect(resolveLocale(["es_MX"])).toBe("es");
    expect(resolveLocale(["de"])).toBe("en");
  });
  it("persists explicit choices and updates the document language", () => {
    setLanguage("ja");
    expect(window.localStorage.getItem("pic-piper.language")).toBe("ja");
    expect(getLocale()).toBe("ja");
    expect(document.documentElement.lang).toBe("ja");
  });
  it("reacts to storage changes and rejects unsupported saved languages", () => {
    window.localStorage.setItem("pic-piper.language", "ko");
    window.dispatchEvent(new StorageEvent("storage", { key: "pic-piper.language" }));
    expect(getLocale()).toBe("ko");
    window.localStorage.setItem("pic-piper.language", "invalid");
    window.dispatchEvent(new StorageEvent("storage", { key: "pic-piper.language" }));
    expect(getLanguagePreference()).toBe("system");
  });
  it("interpolates values literally and chooses image plurals", () => {
    setLanguage("en");
    expect(t("Delete {{value0}}?", { value0: "$&<test>{{value0}}" })).toBe("Delete $&<test>{{value0}}?");
    expect(imageCount(1)).toBe("1 image");
    expect(imageCount(2)).toBe("2 images");
  });
  it("switches the settings UI immediately without saving a storage profile", async () => {
    setLanguage("en");
    render(<SettingsPage settings={{ profiles: [], namingTemplate: "{slug}.{ext}" }} onSettingsChange={() => { throw new Error("Language must not save profiles"); }} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Language" }), "fr");
    expect(getLocale()).toBe("fr");
    expect(screen.getByRole("combobox", { name: t("Language") })).toHaveValue("fr");
  });
  it("follows system changes only while system mode is selected", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["es-MX"]);
    setLanguage("system");
    expect(getLocale()).toBe("es");
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["ko-KR"]);
    window.dispatchEvent(new Event("languagechange"));
    expect(getLocale()).toBe("ko");
    setLanguage("fr");
    window.dispatchEvent(new Event("languagechange"));
    expect(getLocale()).toBe("fr");
    vi.restoreAllMocks();
  });
  it("keeps the session choice when storage is unavailable", () => {
    vi.stubGlobal("localStorage", { setItem: () => { throw new Error("blocked"); } });
    expect(() => setLanguage("ja")).not.toThrow();
    expect(getLocale()).toBe("ja");
  });
  it.each(languages)("updates navigation and settings in $id", async ({ id }) => {
    setLanguage("en");
    render(<Layout activeView="settings" onViewChange={() => {}}><SettingsPage settings={{ profiles: [], namingTemplate: "{slug}.{ext}" }} onSettingsChange={() => {}} /></Layout>);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Language" }), id);
    expect(screen.getByRole("tab", { name: t("Settings") })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: t("Settings") })).toBeVisible();
    expect(screen.getByRole("combobox", { name: t("Language") })).toHaveValue(id);
    if (id !== "en") expect(t("Settings")).not.toBe("Settings");
  });

});
