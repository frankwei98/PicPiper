import { describe, expect, it } from "vitest";
import { unexpectedDraftAssets } from "./release.mjs";

describe("unexpectedDraftAssets", () => {
  it("lists draft assets outside the verified inventory", () => {
    const files = ["/tmp/PicPiper.zip", "/tmp/PicPiper.tar.gz"];
    const assets = [{ name: "PicPiper.zip" }, { name: "stale.dmg" }, { name: "PicPiper.tar.gz" }];
    expect(unexpectedDraftAssets(assets, files)).toEqual(["stale.dmg"]);
  });

  it("accepts a draft that exactly matches the verified inventory", () => {
    expect(unexpectedDraftAssets([{ name: "PicPiper.zip" }], ["/tmp/PicPiper.zip"])).toEqual([]);
  });
});
