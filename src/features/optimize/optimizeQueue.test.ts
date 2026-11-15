import { describe, expect, it } from "vitest";
import {
  AVAILABLE_OUTPUT_FORMATS,
  defaultTargetFormat,
  formatBytes,
  getCompressionConcurrency,
  isCurrentCompressionOutput,
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
  it("preserves encodable input formats and converts HEIF to AVIF", () => {
    for (const format of ["jpg", "png", "webp", "avif", "jxl"] as const) {
      expect(defaultTargetFormat(format)).toBe(format);
    }
    expect(defaultTargetFormat("heif")).toBe("avif");
    expect(defaultTargetFormat("unknown")).toBe("jpg");
  });

  it("offers only supported output formats", () => {
    expect(AVAILABLE_OUTPUT_FORMATS).toEqual(["jpg", "png", "webp", "avif", "jxl"]);
  });

  it("uses half of available cores, rounded up", () => {
    expect(getCompressionConcurrency(10)).toBe(5);
    expect(getCompressionConcurrency(2)).toBe(1);
    expect(getCompressionConcurrency(11)).toBe(6);
    expect(getCompressionConcurrency(12)).toBe(6);
    expect(getCompressionConcurrency(1)).toBe(1);
    expect(getCompressionConcurrency(undefined)).toBe(2);
  });

  it("derives output filename from current target format", () => {
    expect(makeOutputFileName("photo.large.jpg", "jpg")).toBe("photo.large.jpg");
    expect(makeOutputFileName("photo", "jpg")).toBe("photo.jpg");
  });

  it("disambiguates duplicate output filenames", () => {
    const outputNames = makeUniqueOutputFileNames(
      [
        { id: "a", fileName: "photo.jpg", targetFormat: "jpg" },
        { id: "b", fileName: "photo.png", targetFormat: "jpg" },
        { id: "c", fileName: "photo.jpg", targetFormat: "jpg" },
      ],
      new Map(),
    );
    expect(outputNames).toEqual({
      a: "photo.jpg",
      b: "photo-2.jpg",
      c: "photo-3.jpg",
    });
  });

  it("does not let an explicit numeric stem collide with a generated suffix", () => {
    const outputNames = makeUniqueOutputFileNames(
      [
        { id: "a", fileName: "photo.jpg", targetFormat: "jpg" },
        { id: "b", fileName: "photo.png", targetFormat: "jpg" },
        { id: "c", fileName: "photo-2.jpg", targetFormat: "jpg" },
      ],
      new Map(),
    );

    expect(new Set(Object.values(outputNames)).size).toBe(3);
    expect(outputNames).toEqual({
      a: "photo.jpg",
      b: "photo-2.jpg",
      c: "photo-2-2.jpg",
    });
  });

  it("does not reuse names from prior batches (cross-batch uniqueness)", () => {
    const counts = new Map<string, number>();

    // Batch 1: dispatch two items with same preferred name
    const batch1Names = makeUniqueOutputFileNames(
      [
        { id: "p1", fileName: "photo.jpg", targetFormat: "jpg" },
        { id: "p2", fileName: "photo.jpg", targetFormat: "jpg" },
      ],
      counts,
    );
    expect(batch1Names).toEqual({ p1: "photo.jpg", p2: "photo-2.jpg" });

    // Only track the dispatched names (simulating concurrency=1, dispatching p1 only)
    trackDispatchedNames(
      [{ fileName: "photo.jpg", targetFormat: "jpg" }],
      counts,
    );
    expect(counts.get("photo.jpg")).toBe(1);

    // Batch 2: dispatch p2 with updated counts
    const batch2Names = makeUniqueOutputFileNames(
      [{ id: "p2", fileName: "photo.jpg", targetFormat: "jpg" }],
      counts,
    );
    expect(batch2Names.p2).toBe("photo-2.jpg");

    // Track p2 dispatched
    trackDispatchedNames(
      [{ fileName: "photo.jpg", targetFormat: "jpg" }],
      counts,
    );
    expect(counts.get("photo.jpg")).toBe(2);

    // Batch 3: third item with same preferred name
    const batch3Names = makeUniqueOutputFileNames(
      [{ id: "p3", fileName: "photo.jpg", targetFormat: "jpg" }],
      counts,
    );
    // Must NOT collide with p1's "photo.jpg" or p2's "photo-2.jpg"
    expect(batch3Names.p3).toBe("photo-3.jpg");
  });

  it("requeues only active items for global setting changes", () => {
    expect(shouldRequeueForGlobalSettings(item("compressed"))).toBe(true);
    expect(shouldRequeueForGlobalSettings(item("queued"))).toBe(true);
    expect(shouldRequeueForGlobalSettings(item("compressing"))).toBe(true);
    expect(shouldRequeueForGlobalSettings(item("inspecting"))).toBe(false);
    expect(shouldRequeueForGlobalSettings(item("failed"))).toBe(false);
    expect(shouldRequeueForGlobalSettings(item("cancelled"))).toBe(false);
  });

  it("recognizes only compressed outputs for the current quality", () => {
    const compressed = { ...item("compressed"), outputPath: "/tmp/compressed.jpg" };

    expect(isCurrentCompressionOutput(compressed, 85)).toBe(true);
    expect(isCurrentCompressionOutput(compressed, 70)).toBe(false);
    expect(isCurrentCompressionOutput(item("compressed"), 85)).toBe(false);
    expect(
      isCurrentCompressionOutput({ ...compressed, status: "queued" }, 85),
    ).toBe(false);
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
