import { describe, expect, it } from "vitest";
import {
  AVAILABLE_OUTPUT_FORMATS,
  defaultTargetFormat,
  formatBytes,
  getCompressionConcurrency,
  makeOutputFileName,
  makeUniqueOutputFileNames,
  shouldRequeueForGlobalSettings,
} from "./optimizeQueue";
import type { OptimizeItem } from "../../types";

function item(status: OptimizeItem["status"]): OptimizeItem {
  return {
    id: status,
    sourcePath: `/tmp/${status}.jpg`,
    fileName: `${status}.jpg`,
    sourceFormat: "jpg",
    originalBytes: 1000,
    status,
    settings: {
      targetFormat: "jpg",
      quality: 85,
      removeGps: true,
    },
  };
}

describe("optimizeQueue", () => {
  it("defaults target format to source format except HEIF uses WebP", () => {
    expect(defaultTargetFormat("jpg")).toBe("jpg");
    expect(defaultTargetFormat("png")).toBe("png");
    expect(defaultTargetFormat("webp")).toBe("webp");
    expect(defaultTargetFormat("avif")).toBe("avif");
    expect(defaultTargetFormat("heif")).toBe("webp");
    expect(defaultTargetFormat("unknown")).toBe("webp");
  });

  it("does not offer HEIF output", () => {
    expect(AVAILABLE_OUTPUT_FORMATS).toEqual(["jpg", "png", "webp", "avif"]);
  });

  it("computes concurrency as cores minus one with a minimum of one", () => {
    expect(getCompressionConcurrency(10)).toBe(9);
    expect(getCompressionConcurrency(2)).toBe(1);
    expect(getCompressionConcurrency(1)).toBe(1);
    expect(getCompressionConcurrency(undefined)).toBe(3);
  });

  it("derives output filename from current target format", () => {
    expect(makeOutputFileName("photo.large.jpg", "webp")).toBe("photo.large.webp");
    expect(makeOutputFileName("photo", "jpg")).toBe("photo.jpg");
  });

  it("disambiguates duplicate output filenames", () => {
    expect(
      makeUniqueOutputFileNames([
        { id: "a", fileName: "photo.jpg", targetFormat: "webp" },
        { id: "b", fileName: "photo.png", targetFormat: "webp" },
        { id: "c", fileName: "photo.jpg", targetFormat: "jpg" },
      ]),
    ).toEqual({
      a: "photo.webp",
      b: "photo-2.webp",
      c: "photo.jpg",
    });
  });

  it("requeues only active items for global setting changes", () => {
    expect(shouldRequeueForGlobalSettings(item("compressed"))).toBe(true);
    expect(shouldRequeueForGlobalSettings(item("queued"))).toBe(true);
    expect(shouldRequeueForGlobalSettings(item("compressing"))).toBe(true);
    expect(shouldRequeueForGlobalSettings(item("failed"))).toBe(false);
    expect(shouldRequeueForGlobalSettings(item("cancelled"))).toBe(false);
  });

  it("formats bytes for UI", () => {
    expect(formatBytes(1_200_000)).toBe("1.2 MB");
    expect(formatBytes(240_000)).toBe("240 KB");
    expect(formatBytes(0)).toBe("0 KB");
  });
});
