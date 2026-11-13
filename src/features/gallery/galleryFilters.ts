import type { GalleryObject } from "@/types";

export interface GalleryFilters {
  format: string;
  time: "all" | "today" | "week";
  size: "all" | "small" | "large";
}

export const EMPTY_GALLERY_FILTERS: GalleryFilters = { format: "all", time: "all", size: "all" };

export function filterGalleryObjects(objects: GalleryObject[], search: string, filters: GalleryFilters, now = new Date()) {
  const query = search.trim().toLowerCase();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const earliest = filters.time === "today" ? today : now.getTime() - 7 * 24 * 60 * 60 * 1000;
  return objects.filter((object) => {
    const name = object.fileName ?? object.key;
    const extension = name.split(".").pop()?.toLowerCase();
    const format = extension === "jpeg" ? "jpg" : extension === "heic" ? "heif" : extension;
    if (query && !`${object.key} ${name}`.toLowerCase().includes(query)) return false;
    if (filters.format !== "all" && format !== filters.format) return false;
    if (filters.time !== "all") {
      const uploaded = Date.parse(object.uploadedAt ?? object.lastModified ?? "");
      if (!Number.isFinite(uploaded) || uploaded < earliest) return false;
    }
    if (filters.size === "small" && object.size >= 500_000) return false;
    if (filters.size === "large" && object.size < 500_000) return false;
    return true;
  });
}
