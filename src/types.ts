import type { CompressibleImageFormat, WritableImageFormat } from "./lib/imageFormats";

export type AppView = "optimize" | "gallery" | "settings";
export type { CompressibleImageFormat, ImageFormat, WritableImageFormat } from "./lib/imageFormats";

/** @deprecated Use CompressibleImageFormat; this type describes the backend compression decoder. */
export type ReadableImageFormat = CompressibleImageFormat;

export type ImageStatus =
  | "inspecting"
  | "queued"
  | "compressing"
  | "compressed"
  | "failed"
  | "cancelled";

/** Response from the Go image inspection service. */
export interface ImageInspection {
  path: string;
  fileName: string;
  sourceFormat: CompressibleImageFormat | null;
  originalBytes: number;
  width: number;
  height: number;
  bitDepth?: number;
  frameCount?: number;
  animated?: boolean;
  hdr?: boolean;
  estimatedBytes: number | null;
  warning: string | null;
}

export interface CompressionSettings {
  targetFormat: WritableImageFormat;
  quality: number;
  /** Maximum output edge in pixels; omitted or zero preserves original dimensions. */
  maxDimension?: number;
  animationMode?: "preserve" | "firstFrame";
  /** @deprecated Ignored — metadata (including GPS) is always stripped during compression. */
  removeGps: boolean;
}

export interface OptimizeItem {
  id: string;
  sourcePath: string;
  fileName: string;
  sourceFormat: CompressibleImageFormat | "unknown";
  originalBytes: number;
  originalWidth?: number;
  originalHeight?: number;
  originalBitDepth?: number;
  originalFrameCount?: number;
  originalAnimated?: boolean;
  originalHDR?: boolean;
  sourceWarning?: string;
  outputWidth?: number;
  outputHeight?: number;
  estimatedBytes?: number;
  outputBytes?: number;
  outputPath?: string;
  outputFileName?: string;
  status: ImageStatus;
  warning?: string;
  error?: string;
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
  uploadId?: string;
  fileName?: string;
  uploadedAt?: string;
  uploadRecordWarning?: boolean;
  etag?: string;
  key: string;
  size: number;
  lastModified?: string;
  publicUrl?: string;
  isImage: boolean;
}
