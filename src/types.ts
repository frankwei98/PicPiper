export type AppView = "optimize" | "gallery" | "settings";

export type ImageFormat = "jpg" | "png" | "webp" | "avif" | "heif";

export type ImageStatus = "pending" | "ready" | "compressing" | "compressed" | "failed";

export interface CompressionSettings {
  targetFormat: ImageFormat;
  quality: number;
  removeGps: boolean;
}

export interface OptimizeItem {
  id: string;
  sourcePath: string;
  fileName: string;
  sourceFormat: ImageFormat | "unknown";
  originalBytes: number;
  estimatedBytes?: number;
  outputBytes?: number;
  outputPath?: string;
  outputFileName?: string;
  status: ImageStatus;
  warning?: string;
  error?: string;
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
  insecureSecretFallback: boolean;
}

export interface GalleryObject {
  key: string;
  size: number;
  lastModified?: string;
  publicUrl?: string;
  isImage: boolean;
}
