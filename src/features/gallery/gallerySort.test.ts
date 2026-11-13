import { expect, it } from "vitest";
import { sortGalleryObjects } from "./gallerySort";
import type { GalleryObject } from "@/types";

const objects: GalleryObject[] = [
  { key: "images/z.png", fileName: "Zulu.png", uploadedAt: "2026-01-01T00:00:00.000000001Z", size: 1, isImage: true },
  { key: "images/a.png", fileName: "alpha.png", uploadedAt: "2026-01-01T00:00:00.000000003Z", size: 1, isImage: true },
  { key: "images/m.png", fileName: "Middle.png", uploadedAt: "2026-01-01T00:00:00.000000002Z", size: 1, isImage: true },
];
it.each([
  ["time-desc", ["alpha.png", "Middle.png", "Zulu.png"]],
  ["time-asc", ["Zulu.png", "Middle.png", "alpha.png"]],
  ["name-asc", ["alpha.png", "Middle.png", "Zulu.png"]],
  ["name-desc", ["Zulu.png", "Middle.png", "alpha.png"]],
] as const)("keeps newly uploaded items in %s order without modifying the source", (order, names) => {
  expect(sortGalleryObjects(objects, order).map((object) => object.fileName)).toEqual(names);
  expect(objects[0].fileName).toBe("Zulu.png");
});
