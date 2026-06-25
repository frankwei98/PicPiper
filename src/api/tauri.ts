import { invoke } from "@tauri-apps/api/core";
import type { CompressionSettings, OptimizeItem } from "../types";

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
