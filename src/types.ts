import type { CompressibleImageFormat, WritableImageFormat } from "./lib/imageFormats";

export type AppView = "optimize" | "gallery" | "settings";
export type { CompressibleImageFormat, ImageFormat, WritableImageFormat } from "./lib/imageFormats";

/** @deprecated Use CompressibleImageFormat; this type describes the backend compression decoder. */
export type ReadableImageFormat = CompressibleImageFormat;

export type ImageStatus =
  | "inspecting"
  | "queued"
  | "compressing"
  | "loadingPreview"
  | "compressed"
  | "failed"
  | "cancelled";

/** Response from the Rust inspect_image command. */
export interface ImageInspection {
  path: string;
  fileName: string;
  sourceFormat: CompressibleImageFormat | null;
  originalBytes: number;
  width: number;
  height: number;
  estimatedBytes: number | null;
  warning: string | null;
}

export interface CompressionSettings {
  targetFormat: WritableImageFormat;
  quality: number;
  /** @deprecated Ignored — metadata (including GPS) is always stripped during compression. */
  removeGps: boolean;
}

export interface OptimizeItem {
  id: string;
  sourcePath: string;
  fileName: string;
  sourceFormat: CompressibleImageFormat | "unknown";
  originalBytes: number;
  estimatedBytes?: number;
  outputBytes?: number;
  outputPath?: string;
  outputFileName?: string;
  status: ImageStatus;
  warning?: string;
  error?: string;
  originalPreviewUrl?: string;
  compressedPreviewUrl?: string;
  taskVersion?: number;
  cancelling?: boolean;
  settings: CompressionSettings;
}

export interface CompressionResult {
  items: OptimizeItem[];
  totalOriginalBytes: number;
  totalOutputBytes: number;
}

export interface S3Profile {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  credentialRef?: string;
  pathStyle: boolean;
  publicBaseUrl?: string;
  defaultPrefix: string;
}

export interface GalleryObject {
  key: string;
  size: number;
  lastModified?: string;
  publicUrl?: string;
  isImage: boolean;
}
