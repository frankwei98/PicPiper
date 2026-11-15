import { t } from "@/i18n";
import { Backend, events } from "../mygo";
import { isMyGo } from "mygo-runtime";
import type { CompressionSettings, GalleryObject, ImageInspection, S3Profile, WritableImageFormat } from "../types";

interface Response<T> {
  data: T;
  error?: { code: string; message: string };
}

async function invoke<T>(operation: string, args?: { request?: unknown }): Promise<T> {
  if (!isMyGo()) throw new Error(t("Open Pic Piper as a desktop app to use local files and storage."));
  const response: Response<T> = JSON.parse(await Backend.call(operation, JSON.stringify(args?.request ?? {})));
  if (response.error) {
    throw Object.assign(new Error(response.error.message), { code: response.error.code });
  }
  return response.data;
}

export interface InspectImageRequest {
  taskId?: string;
  path: string;
  settings: CompressionSettings;
}

export interface CompressImageRequest {
  taskId?: string;
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
  width?: number;
  height?: number;
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
  taskId?: string;
  path: string;
  maxSize?: number;
}

export interface ReadThumbnailResponse {
  dataUrl: string;
}

export interface ReadComparisonImageRequest {
  taskId: string;
  path: string;
}

export interface ReadComparisonImageResponse {
  dataUrl: string;
  width: number;
  height: number;
}

export const imageApi = {
  copyImages: (outputPaths: string[]) => invoke<void>("copy_compressed_images", { request: { outputPaths } }),
  cancelImageTask: (request: { taskId: string }) => invoke<void>("cancel_image_task", { request }),
  inspectImage: (request: InspectImageRequest) => invoke<ImageInspection>("inspect_image", { request }),
  createOptimizerRun: () => invoke<CreateOptimizerRunResponse>("create_optimizer_run"),
  compressImage: (request: CompressImageRequest) => invoke<CompressImageResult>("compress_image", { request }),
  copyOutputsToDir: (request: CopyOutputsRequest) => invoke<string[]>("copy_outputs_to_dir", { request }),
  readThumbnail: (request: ReadThumbnailRequest) => invoke<ReadThumbnailResponse>("read_thumbnail", { request }),
  readComparisonImage: (request: ReadComparisonImageRequest) => invoke<ReadComparisonImageResponse>("read_comparison_image", { request }),
};

export interface ListGalleryObjectsRequest {
  sort?: "time-desc" | "time-asc" | "name-asc" | "name-desc";
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
  readThumbnail: (request: { profile: S3Profile; key: string; etag?: string; size: number; lastModified?: string }) => invoke<{ dataUrl: string }>("read_gallery_thumbnail", { request }),
  listObjects: (request: ListGalleryObjectsRequest) => invoke<ListGalleryObjectsResponse>("list_gallery_objects", { request }),
  deleteObject: (request: DeleteObjectRequest) => invoke<void>("delete_gallery_object", { request }),
  downloadObject: (request: DownloadObjectRequest) => invoke<string>("download_gallery_object", { request }),
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
  uploadObject: (request: UploadObjectRequest) => invoke<GalleryObject>("upload_gallery_object", { request }),
};

export interface GenerateObjectKeyRequest {
  sourcePath: string;
  outputFileName: string;
  prefix: string;
  namingTemplate: string;
  ext: string;
  collisionSuffix?: string;
}

export interface GenerateObjectKeyResponse {
  objectKey: string;
}

export const namingApi = {
  generateObjectKey: (request: GenerateObjectKeyRequest) => invoke<GenerateObjectKeyResponse>("generate_object_key", { request }),
};

export interface AppSettings {
  closeBehavior?: "quit" | "background";
  mini?: MiniSettings;
  onboardingCompleted?: boolean;
  features?: { compression: boolean; s3: boolean };
  profiles: S3Profile[];
  namingTemplate: string;
  defaultOutputDir?: string;
  defaultProfileId?: string;
}

export interface MiniSettings {
  enabled: boolean;
  targetFormat: WritableImageFormat;
  quality: number;
  /** Legacy persisted field; Mini always copies images. Uploads are explicit. */
  action: "clipboard" | "upload";
  profileId: string;
  linkFormat: "url" | "html" | "bbcode" | "markdown";
}

export const defaultMiniSettings: MiniSettings = {
  enabled: false, targetFormat: "webp", quality: 90, action: "clipboard", profileId: "", linkFormat: "url",
};

export interface MiniItem {
  id: string; name: string; status: "queued" | "compressing" | "uploading" | "completed" | "failed";
  outputName: string; originalBytes: number; outputBytes: number; thumbnail: string;
  url: string; links?: Record<MiniSettings["linkFormat"], string>; error: string; warning: string;
  uploadStatus?: "queued" | "uploading" | "completed" | "failed"; uploadError?: string;
  uploads?: Record<string, string>; linkFormat?: MiniSettings["linkFormat"]; completedAt?: string;
}
export interface MiniState { items: MiniItem[]; busy: boolean; copied: "" | "image" | "links"; error: string; canUndoClear?: boolean; copySequence?: number }
export interface MiniUploadTarget { profileId: string; name: string; bucket: string; bucketKey: string }
export const miniApi = {
  export: (ids: string[], targetDir: string) => invoke<string[]>("mini_export", { request: { ids, targetDir } }),
  state: () => invoke<MiniState>("mini_state"),
  add: (paths: string[]) => invoke<MiniState>("mini_add", { request: { paths } }),
  upload: (ids: string[], profileId: string, linkFormat: MiniSettings["linkFormat"]) => invoke<MiniState>("mini_upload", { request: { ids, profileId, linkFormat } }),
  targets: () => invoke<MiniUploadTarget[]>("mini_upload_targets"),
  clear: () => invoke<MiniState>("mini_clear"),
  restore: () => invoke<MiniState>("mini_restore"),
  copyImage: (id: string) => invoke<void>("mini_copy_image", { request: { id } }),
  copy: (id: string, linkFormat: MiniSettings["linkFormat"]) => invoke<void>("mini_copy", { request: { id, linkFormat } }),
  copyAll: (linkFormat: MiniSettings["linkFormat"]) => invoke<void>("mini_copy_all", { request: { linkFormat } }),
  save: (settings: MiniSettings) => invoke<void>("save_mini_settings", { request: { settings } }),
  window: (action: "main" | "close" | "open") => Backend.miniWindow(action),
};

export interface SaveS3SecretRequest {
  profileId: string;
  secretAccessKey: string;
}

export interface TestS3ConnectionRequest {
  profile: S3Profile;
  secretAccessKey?: string;
}

export const settingsApi = {
  onChanged: (listener: () => void): (() => void) => isMyGo() ? events.settingsChanged.on(() => listener()) : () => {},
  loadSettings: () => invoke<AppSettings>("load_app_settings"),
  saveSettings: (settings: AppSettings) => invoke<void>("save_app_settings", { request: { settings } }),
  saveS3Secret: (request: SaveS3SecretRequest) => invoke<{ credentialRef: string }>("save_s3_secret", { request }),
  testS3Connection: (request: TestS3ConnectionRequest) => invoke<void>("test_s3_connection", { request }),
};

export interface R2Account { id: string; name: string }
export interface R2Bucket { name: string; jurisdiction: string }
export interface R2Selection { sessionId: string; accountId: string; jurisdiction: string }
export const r2Api = {
  start: () => invoke<{ sessionId: string; authorizationUrl: string }>("start_r2_oauth"),
  poll: (sessionId: string) => invoke<{ status: "pending" | "exchanging" | "authorized" | "failed" | "expired" | "closed"; message: string }>("poll_r2_oauth", { request: { sessionId } }),
  cancel: (sessionId: string) => invoke<void>("cancel_r2_oauth", { request: { sessionId } }),
  accounts: (sessionId: string) => invoke<R2Account[]>("list_r2_accounts", { request: { sessionId } }),
  buckets: (request: R2Selection) => invoke<R2Bucket[]>("list_r2_buckets", { request }),
  connect: (request: R2Selection & { buckets: string[]; publicBaseUrls?: Record<string, string> }) => invoke<AppSettings>("connect_r2_buckets", { request }),
};
