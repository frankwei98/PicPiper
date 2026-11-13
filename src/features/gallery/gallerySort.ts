import type { GalleryObject } from "@/types";
import { fileNameFromPath } from "@/lib/path";

export type GallerySort = "time-desc" | "time-asc" | "name-asc" | "name-desc";

// Compare Unicode code points, matching the backend's UTF-8 ordering.
function compareText(a: string, b: string) {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const delta = left[index].codePointAt(0)! - right[index].codePointAt(0)!;
    if (delta) return delta;
  }
  return left.length - right.length;
}
function lower(value: string) { return Array.from(value, (character) => Array.from(character.toLowerCase())[0]).join(""); }
function timestamp(object: GalleryObject) {
  if (object.uploadedAt) return object.uploadedAt;
  const parsed = Date.parse(object.lastModified ?? "");
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString().replace("Z", "000000Z");
}
export function sortGalleryObjects(objects: GalleryObject[], order: GallerySort) {
  return [...objects].sort((a, b) => {
    let compared: number;
    if (order.startsWith("name-")) {
      compared = compareText(lower(a.fileName ?? fileNameFromPath(a.key)), lower(b.fileName ?? fileNameFromPath(b.key)));
      if (order === "name-desc") compared = -compared;
    } else {
      compared = compareText(timestamp(a), timestamp(b));
      if (order === "time-desc") compared = -compared;
    }
    return compared || compareText(a.key, b.key);
  });
}
