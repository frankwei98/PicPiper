import { invoke } from "@tauri-apps/api/core";
import type { CompressionSettings, GalleryObject, OptimizeItem, S3ProfileSummary } from "../types";

export interface InspectImageRequest {
  path: string;
  settings: CompressionSettings;
}

export interface CompressImageRequest {
  sourcePath: string;
  outputDir: string;
  outputFileName: string;
  settings: CompressionSettings;
}

export interface CompressImageResult {
  sourcePath: string;
  outputPath: string;
  outputFileName: string;
  originalBytes: number;
  outputBytes: number;
  targetFormat: CompressionSettings["targetFormat"];
  warning?: string;
}

export const tauriApi = {
  inspectImage: (request: InspectImageRequest) =>
    invoke<OptimizeItem>("inspect_image", { request }),
  compressImage: (request: CompressImageRequest) =>
    invoke<CompressImageResult>("compress_image", { request }),
};

export interface ListGalleryObjectsRequest {
  profile: S3ProfileSummary;
  prefix: string;
}

export const galleryApi = {
  listObjects: (request: ListGalleryObjectsRequest) =>
    invoke<GalleryObject[]>("list_gallery_objects", { request }),
};

export interface UploadObjectRequest {
  profile: S3ProfileSummary;
  sourcePath: string;
  objectKey: string;
  contentType?: string;
}

export const uploadApi = {
  uploadObject: (request: UploadObjectRequest) =>
    invoke<GalleryObject>("upload_gallery_object", { request }),
};

export interface AppSettings {
  profiles: S3ProfileSummary[];
  presets: Array<{
    id: string;
    name: string;
    targetFormat: string;
    quality: number;
    maxWidth: number;
    maxHeight: number;
    allowUpscale: boolean;
    removeGps: boolean;
  }>;
  namingTemplate: string;
  defaultOutputDir?: string;
  defaultProfileId?: string;
}

export interface SaveS3SecretRequest {
  profileId: string;
  secretAccessKey: string;
  allowInsecureFallback: boolean;
}

export const settingsApi = {
  loadSettings: () => invoke<AppSettings>("load_app_settings"),
  saveSettings: (settings: AppSettings) =>
    invoke<void>("save_app_settings", { request: { settings } }),
  saveS3Secret: (request: SaveS3SecretRequest) =>
    invoke<{ credentialRef: string; insecureFallbackUsed: boolean }>("save_s3_secret", { request }),
};
