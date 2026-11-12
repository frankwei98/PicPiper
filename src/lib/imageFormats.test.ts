import { describe, expect, it } from "vitest";
import { contentTypeForExtension, extensionsFor, writableImageFormats } from "./imageFormats";

describe("image format capabilities", () => {
  it("imports modern formats and HEIF while keeping HEIF read-only", () => {
    const inputs = ["jpg", "jpeg", "png", "webp", "avif", "jxl", "heif", "heic"];
    expect(extensionsFor("compressImport")).toEqual(inputs);
    expect(extensionsFor("galleryUpload")).toEqual(inputs);
    expect(writableImageFormats()).toEqual(["jpg", "png", "webp", "avif", "jxl"]);
  });

  it("maps encoded uploads to the actual format MIME type", () => {
    expect(contentTypeForExtension("jpeg")).toBe("image/jpeg");
    expect(contentTypeForExtension("WEBP")).toBe("image/webp");
    expect(contentTypeForExtension("avif")).toBe("image/avif");
    expect(contentTypeForExtension("JXL")).toBe("image/jxl");
    expect(contentTypeForExtension("HEIC")).toBe("image/heic");
    expect(contentTypeForExtension("unknown")).toBe("application/octet-stream");
  });
});
