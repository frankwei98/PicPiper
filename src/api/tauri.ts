import { invoke } from "@tauri-apps/api/core";
import type { CompressionSettings, GalleryObject, OptimizeItem, S3Profile } from "../types";

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

export interface CompressBatchItem {
  id: string;
  sourcePath: string;
  outputFileName: string;
  settings: CompressionSettings;
}

export interface CompressBatchRequest {
  items: CompressBatchItem[];
}

export interface ItemError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface CompressBatchItemResult {
  id: string;
  result?: CompressImageResult;
  error?: ItemError;
}

export interface CompressBatchResponse {
  runId: string;
  outputDir: string;
  items: CompressBatchItemResult[];
}

export interface CopyOutputsRequest {
  outputPaths: string[];
  targetDir: string;
}

export const tauriApi = {
  inspectImage: (request: InspectImageRequest) =>
    invoke<OptimizeItem>("inspect_image", { request }),
  compressImage: (request: CompressImageRequest) =>
    invoke<CompressImageResult>("compress_image", { request }),
  compressBatch: (request: CompressBatchRequest) =>
    invoke<CompressBatchResponse>("compress_batch", { request }),
  copyOutputsToDir: (request: CopyOutputsRequest) =>
    invoke<string[]>("copy_outputs_to_dir", { request }),
};

export interface ListGalleryObjectsRequest {
  profile: S3Profile;
  prefix: string;
}

export interface DeleteObjectRequest {
  profile: S3Profile;
  key: string;
}

export interface DownloadObjectRequest {
  profile: S3Profile;
  key: string;
  outputPath: string;
}

export const galleryApi = {
  listObjects: (request: ListGalleryObjectsRequest) =>
    invoke<GalleryObject[]>("list_gallery_objects", { request }),
  deleteObject: (request: DeleteObjectRequest) =>
    invoke<void>("delete_gallery_object", { request }),
  downloadObject: (request: DownloadObjectRequest) =>
    invoke<string>("download_gallery_object", { request }),
};

export interface UploadObjectRequest {
  profile: S3Profile;
  sourcePath: string;
  objectKey: string;
  contentType?: string;
}

export const uploadApi = {
  uploadObject: (request: UploadObjectRequest) =>
    invoke<GalleryObject>("upload_gallery_object", { request }),
};

export interface AppSettings {
  profiles: S3Profile[];
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
