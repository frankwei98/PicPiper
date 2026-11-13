import { describe, expect, it } from "vitest";
import type { GalleryObject } from "@/types";
import { EMPTY_GALLERY_FILTERS, filterGalleryObjects } from "./galleryFilters";

const now = new Date(2026, 10, 13, 12);
const objects: GalleryObject[] = [
  { key: "images/a.JPEG", fileName: "Coast.JPEG", size: 499_999, uploadedAt: new Date(2026, 10, 13, 8).toISOString(), isImage: true },
  { key: "images/b.png", size: 500_000, lastModified: new Date(2026, 10, 11).toISOString(), isImage: true },
  { key: "images/c.heic", size: 800_000, uploadedAt: new Date(2026, 9, 1).toISOString(), isImage: true },
  { key: "images/no-date.webp", size: 200, isImage: true },
];

describe("gallery filters", () => {
  it("combines the source filename search, normalized format and strict size boundary", () => {
    expect(filterGalleryObjects(objects, "coast", { ...EMPTY_GALLERY_FILTERS, format: "jpg", size: "small" }, now)).toEqual([objects[0]]);
    expect(filterGalleryObjects(objects, "", { ...EMPTY_GALLERY_FILTERS, size: "large" }, now)).toEqual([objects[1], objects[2]]);
    expect(filterGalleryObjects(objects, "", { ...EMPTY_GALLERY_FILTERS, format: "heif" }, now)).toEqual([objects[2]]);
  });

  it("uses local calendar days, supports legacy timestamps and excludes undated records only for time filters", () => {
    expect(filterGalleryObjects(objects, "", { ...EMPTY_GALLERY_FILTERS, time: "today" }, now)).toEqual([objects[0]]);
    expect(filterGalleryObjects(objects, "", { ...EMPTY_GALLERY_FILTERS, time: "week" }, now)).toEqual(objects.slice(0, 2));
    expect(filterGalleryObjects(objects, "", EMPTY_GALLERY_FILTERS, now)).toEqual(objects);
  });
});
