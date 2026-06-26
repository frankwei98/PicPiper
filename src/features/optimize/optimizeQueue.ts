import type { ImageFormat, OptimizeItem } from "../../types";

export const AVAILABLE_OUTPUT_FORMATS = ["jpg", "png", "webp", "avif"] as const satisfies ReadonlyArray<ImageFormat>;

export type AvailableOutputFormat = (typeof AVAILABLE_OUTPUT_FORMATS)[number];

export function defaultTargetFormat(sourceFormat: OptimizeItem["sourceFormat"]): ImageFormat {
  if (sourceFormat === "jpg" || sourceFormat === "png" || sourceFormat === "webp" || sourceFormat === "avif") {
    return sourceFormat;
  }
  return "webp";
}

export function getCompressionConcurrency(hardwareConcurrency: number | undefined): number {
  return Math.max(1, (hardwareConcurrency ?? 4) - 1);
}

export function makeOutputFileName(fileName: string, targetFormat: ImageFormat): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  const stem = base || fileName || "image";
  return `${stem}.${targetFormat}`;
}

export function makeUniqueOutputFileNames(
  items: Array<{ id: string; fileName: string; targetFormat: ImageFormat }>,
): Record<string, string> {
  const seen = new Map<string, number>();
  const outputNames: Record<string, string> = {};

  for (const item of items) {
    const preferredName = makeOutputFileName(item.fileName, item.targetFormat);
    const count = (seen.get(preferredName) ?? 0) + 1;
    seen.set(preferredName, count);
    outputNames[item.id] = count === 1 ? preferredName : appendSuffix(preferredName, count);
  }

  return outputNames;
}

function appendSuffix(fileName: string, suffix: number): string {
  const match = /^(.*)\.([^.]+)$/.exec(fileName);
  if (!match) return `${fileName}-${suffix}`;
  return `${match[1]}-${suffix}.${match[2]}`;
}

export function shouldRequeueForGlobalSettings(item: OptimizeItem): boolean {
  return item.status !== "inspecting" && item.status !== "failed" && item.status !== "cancelled";
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}

export function savingsPercent(originalBytes: number, outputBytes: number): number {
  if (originalBytes <= 0) return 0;
  return Math.max(0, Math.round((1 - outputBytes / originalBytes) * 100));
}
