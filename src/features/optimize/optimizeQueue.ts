import { t } from "@/i18n";
import type { OptimizeItem, WritableImageFormat } from "../../types";
import { writableImageFormats } from "../../lib/imageFormats";

export const AVAILABLE_OUTPUT_FORMATS = writableImageFormats();

export type AvailableOutputFormat = (typeof AVAILABLE_OUTPUT_FORMATS)[number];

export function defaultTargetFormat(sourceFormat: OptimizeItem["sourceFormat"]): WritableImageFormat {
  if (sourceFormat === "heif") return "avif";
  return sourceFormat !== "unknown" && AVAILABLE_OUTPUT_FORMATS.includes(sourceFormat) ? sourceFormat : "jpg";
}

export function getCompressionConcurrency(hardwareConcurrency: number | undefined): number {
  return Math.max(1, Math.ceil((hardwareConcurrency ?? 4) / 2));
}

export function makeOutputFileName(fileName: string, targetFormat: WritableImageFormat): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  let stem = base.replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, "_").replace(/[. ]+$/g, "");
  if (!stem) stem = "image";
  const firstComponent = stem.split(".", 1)[0];
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(firstComponent)) {
    stem = `${firstComponent}-image${stem.slice(firstComponent.length)}`;
  }
  return `${stem}.${targetFormat}`;
}

export function makeUniqueOutputFileNames(
  items: Array<{ id: string; fileName: string; targetFormat: WritableImageFormat }>,
  preferredCounts: Map<string, number>,
): Record<string, string> {
  const counts = new Map<string, number>(preferredCounts);
  const usedNames = new Set<string>();
  const outputNames: Record<string, string> = {};

  for (const item of items) {
    const preferredName = makeOutputFileName(item.fileName, item.targetFormat);
    let count = (counts.get(preferredName) ?? 0) + 1;
    let candidate = count === 1 ? preferredName : appendSuffix(preferredName, count);
    while (usedNames.has(candidate)) {
      count += 1;
      candidate = appendSuffix(preferredName, count);
    }
    counts.set(preferredName, count);
    usedNames.add(candidate);
    outputNames[item.id] = candidate;
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
  return Math.round((1 - outputBytes / originalBytes) * 100);
}

export function sizeChangeLabel(originalBytes: number, outputBytes: number): string {
  if (originalBytes <= 0) return t("Size change unavailable");
  if (originalBytes === outputBytes) return t("No size change");
  const percent = Math.abs(savingsPercent(originalBytes, outputBytes));
  return t(outputBytes > originalBytes ? "{{percent}}% larger" : "{{percent}}% saved", { percent: percent || "<1" });
}
