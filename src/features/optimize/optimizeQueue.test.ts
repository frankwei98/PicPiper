import { describe, expect, it } from "vitest";
import {
  AVAILABLE_OUTPUT_FORMATS,
  defaultTargetFormat,
  formatBytes,
  getCompressionConcurrency,
  makeOutputFileName,
  makeUniqueOutputFileNames,
  trackDispatchedNames,
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
    const outputNames = makeUniqueOutputFileNames(
      [
        { id: "a", fileName: "photo.jpg", targetFormat: "webp" },
        { id: "b", fileName: "photo.png", targetFormat: "webp" },
        { id: "c", fileName: "photo.jpg", targetFormat: "jpg" },
      ],
      new Map(),
    );
    expect(outputNames).toEqual({
      a: "photo.webp",
      b: "photo-2.webp",
      c: "photo.jpg",
    });
  });

  it("does not reuse names from prior batches (cross-batch uniqueness)", () => {
    const counts = new Map<string, number>();

    // Batch 1: dispatch two items with same preferred name
    const batch1Names = makeUniqueOutputFileNames(
      [
        { id: "p1", fileName: "photo.jpg", targetFormat: "webp" },
        { id: "p2", fileName: "photo.jpg", targetFormat: "webp" },
      ],
      counts,
    );
    expect(batch1Names).toEqual({ p1: "photo.webp", p2: "photo-2.webp" });

    // Only track the dispatched names (simulating concurrency=1, dispatching p1 only)
    trackDispatchedNames(
      [{ fileName: "photo.jpg", targetFormat: "webp" }],
      counts,
    );
    expect(counts.get("photo.webp")).toBe(1);

    // Batch 2: dispatch p2 with updated counts
    const batch2Names = makeUniqueOutputFileNames(
      [{ id: "p2", fileName: "photo.jpg", targetFormat: "webp" }],
      counts,
    );
    expect(batch2Names.p2).toBe("photo-2.webp");

    // Track p2 dispatched
    trackDispatchedNames(
      [{ fileName: "photo.jpg", targetFormat: "webp" }],
      counts,
    );
    expect(counts.get("photo.webp")).toBe(2);

    // Batch 3: third item with same preferred name
    const batch3Names = makeUniqueOutputFileNames(
      [{ id: "p3", fileName: "photo.jpg", targetFormat: "webp" }],
      counts,
    );
    // Must NOT collide with p1's "photo.webp" or p2's "photo-2.webp"
    expect(batch3Names.p3).toBe("photo-3.webp");
  });

  it("requeues only active items for global setting changes", () => {
    expect(shouldRequeueForGlobalSettings(item("compressed"))).toBe(true);
    expect(shouldRequeueForGlobalSettings(item("queued"))).toBe(true);
    expect(shouldRequeueForGlobalSettings(item("compressing"))).toBe(true);
    expect(shouldRequeueForGlobalSettings(item("inspecting"))).toBe(false);
    expect(shouldRequeueForGlobalSettings(item("failed"))).toBe(false);
    expect(shouldRequeueForGlobalSettings(item("cancelled"))).toBe(false);
  });

  it("formats bytes for UI", () => {
    expect(formatBytes(1_200_000)).toBe("1.2 MB");
    expect(formatBytes(240_000)).toBe("240 KB");
    expect(formatBytes(0)).toBe("0 B");
  });

  it("shows bytes for values below 1000", () => {
    expect(formatBytes(499)).toBe("499 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1000)).toBe("1 KB");
  });
});
