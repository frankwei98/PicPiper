import type { OptimizeItem, WritableImageFormat } from "../../types";
import { writableImageFormats } from "../../lib/imageFormats";

export const AVAILABLE_OUTPUT_FORMATS = writableImageFormats();
export const MAX_COMPRESSION_CONCURRENCY = 3;

export type AvailableOutputFormat = (typeof AVAILABLE_OUTPUT_FORMATS)[number];

export function defaultTargetFormat(_sourceFormat: OptimizeItem["sourceFormat"]): WritableImageFormat {
  return "webp";
}

export function getCompressionConcurrency(hardwareConcurrency: number | undefined): number {
  return Math.min(MAX_COMPRESSION_CONCURRENCY, Math.max(1, (hardwareConcurrency ?? 4) - 1));
}

export function makeOutputFileName(fileName: string, targetFormat: WritableImageFormat): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  const stem = base || fileName || "image";
  return `${stem}.${targetFormat}`;
}

export function makeUniqueOutputFileNames(
  items: Array<{ id: string; fileName: string; targetFormat: WritableImageFormat }>,
  preferredCounts: Map<string, number>,
): Record<string, string> {
  const counts = new Map<string, number>(preferredCounts);
  const outputNames: Record<string, string> = {};

  for (const item of items) {
    const preferredName = makeOutputFileName(item.fileName, item.targetFormat);
    const count = (counts.get(preferredName) ?? 0) + 1;
    counts.set(preferredName, count);
    outputNames[item.id] = count === 1 ? preferredName : appendSuffix(preferredName, count);
  }

  return outputNames;
}

/// Increment preferred name counts for the items that were actually dispatched.
/// Call this AFTER dispatching items so the next scheduler run sees the correct counts.
export function trackDispatchedNames(
  dispatchedItems: Array<{ fileName: string; targetFormat: WritableImageFormat }>,
  preferredCounts: Map<string, number>,
): void {
  for (const item of dispatchedItems) {
    const preferredName = makeOutputFileName(item.fileName, item.targetFormat);
    preferredCounts.set(preferredName, (preferredCounts.get(preferredName) ?? 0) + 1);
  }
}

function appendSuffix(fileName: string, suffix: number): string {
  const match = /^(.*)\.([^.]+)$/.exec(fileName);
  if (!match) return `${fileName}-${suffix}`;
  return `${match[1]}-${suffix}.${match[2]}`;
}

export function shouldRequeueForGlobalSettings(item: OptimizeItem): boolean {
  return item.status !== "inspecting" && item.status !== "failed" && item.status !== "cancelled";
}

export function isCurrentCompressionOutput(
  item: OptimizeItem,
  currentQuality: number,
): item is OptimizeItem & { outputPath: string } {
  return (
    item.status === "compressed" &&
    Boolean(item.outputPath) &&
    item.settings.quality === currentQuality
  );
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

export function savingsPercent(originalBytes: number, outputBytes: number): number {
  if (originalBytes <= 0) return 0;
  return Math.max(0, Math.round((1 - outputBytes / originalBytes) * 100));
}
