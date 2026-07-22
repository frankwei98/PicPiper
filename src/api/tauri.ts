import { invoke } from "@tauri-apps/api/core";
import type { CompressionSettings, GalleryObject, ImageInspection, S3Profile, WritableImageFormat } from "../types";

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

export interface CreateOptimizerRunResponse {
  runId: string;
  outputDir: string;
}

export interface CopyOutputsRequest {
  outputPaths: string[];
  targetDir: string;
}

export interface ReadThumbnailRequest {
  path: string;
  maxSize?: number;
}

export interface ReadThumbnailResponse {
  dataUrl: string;
}

export const tauriApi = {
  inspectImage: (request: InspectImageRequest) =>
    invoke<ImageInspection>("inspect_image", { request }),
  createOptimizerRun: () =>
    invoke<CreateOptimizerRunResponse>("create_optimizer_run"),
  compressImage: (request: CompressImageRequest) =>
    invoke<CompressImageResult>("compress_image", { request }),
  copyOutputsToDir: (request: CopyOutputsRequest) =>
    invoke<string[]>("copy_outputs_to_dir", { request }),
  readThumbnail: (request: ReadThumbnailRequest) =>
    invoke<ReadThumbnailResponse>("read_thumbnail", { request }),
};

export interface ListGalleryObjectsRequest {
  profile: S3Profile;
  prefix: string;
  continuationToken?: string;
  pageSize?: number;
}

export interface ListGalleryObjectsResponse {
  objects: GalleryObject[];
  nextContinuationToken?: string | null;
}

export interface DeleteObjectRequest {
  profile: S3Profile;
  key: string;
}

export interface DownloadObjectRequest {
  profile: S3Profile;
  key: string;
  outputDir: string;
}

export const galleryApi = {
  listObjects: (request: ListGalleryObjectsRequest) =>
    invoke<ListGalleryObjectsResponse>("list_gallery_objects", { request }),
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
  sourceFilename?: string;
  outputFilename?: string;
  originalBytes?: number;
  targetFormat?: WritableImageFormat;
}

export const uploadApi = {
  uploadObject: (request: UploadObjectRequest) =>
    invoke<GalleryObject>("upload_gallery_object", { request }),
};

export interface GenerateObjectKeyRequest {
  sourcePath: string;
  outputFileName: string;
  prefix: string;
  namingTemplate: string;
  ext: string;
  /** Appended before the extension for an explicit create-only collision retry. */
  collisionSuffix?: string;
}

export interface GenerateObjectKeyResponse {
  objectKey: string;
}

export const namingApi = {
  generateObjectKey: (request: GenerateObjectKeyRequest) =>
    invoke<GenerateObjectKeyResponse>("generate_object_key", { request }),
};

export interface AppSettings {
  profiles: S3Profile[];
  namingTemplate: string;
  defaultOutputDir?: string;
  defaultProfileId?: string;
}

export interface SaveS3SecretRequest {
  profileId: string;
  secretAccessKey: string;
}

export const settingsApi = {
  loadSettings: () => invoke<AppSettings>("load_app_settings"),
  saveSettings: (settings: AppSettings) =>
    invoke<void>("save_app_settings", { request: { settings } }),
  saveS3Secret: (request: SaveS3SecretRequest) =>
    invoke<{ credentialRef: string }>("save_s3_secret", { request }),
};
