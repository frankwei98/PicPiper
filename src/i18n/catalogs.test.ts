import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import fr from "./locales/fr.json";
import es from "./locales/es.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";

describe("translation catalogs", () => {
  for (const [locale, catalog] of Object.entries({ en, "zh-CN": zhCN, fr, es, ja, ko })) {
    it(`${locale} contains every message and preserves interpolation`, () => {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(en).sort());
      for (const key of Object.keys(en) as Array<keyof typeof en>) {
        expect(catalog[key].trim(), key).not.toBe("");
        expect(catalog[key].match(/\{\{\w+\}\}/g)?.sort() ?? [], key)
          .toEqual(en[key].match(/\{\{\w+\}\}/g)?.sort() ?? []);
      }
    });
  }
});
