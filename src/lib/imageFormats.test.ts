import { describe, expect, it } from "vitest";
import { contentTypeForExtension, extensionsFor, writableImageFormats } from "./imageFormats";

describe("image format capabilities", () => {
  it("keeps compression inputs within the backend decoder while allowing HEIF originals in Gallery", () => {
    expect(extensionsFor("compressImport")).toEqual(["jpg", "jpeg", "png", "webp", "avif"]);
    expect(extensionsFor("galleryUpload")).toEqual(["jpg", "jpeg", "png", "webp", "avif", "heif", "heic"]);
  });

  it("exposes only encodable target formats and maps upload extensions to their MIME types", () => {
    expect(writableImageFormats()).toEqual(["jpg", "png", "webp", "avif"]);
    expect(contentTypeForExtension("jpeg")).toBe("image/jpeg");
    expect(contentTypeForExtension("HEIC")).toBe("image/heic");
    expect(contentTypeForExtension("unknown")).toBe("application/octet-stream");
  });
});
