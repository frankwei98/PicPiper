import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { CompressionSettings, ImageInspection, OptimizeItem, S3Profile, WritableImageFormat } from "../../types";
import type { GalleryFocus } from "../../state/appState";
import { namingApi, tauriApi, uploadApi } from "../../api/tauri";
import { cn } from "../../utils/cn";
import { Slider } from "../../components/ui/Slider";
import { Dialog } from "../../components/ui/Dialog";
import { btnPrimary, btnSecondary, btnTertiary } from "../../components/ui/buttonStyles";
import {
  AVAILABLE_OUTPUT_FORMATS,
  defaultTargetFormat,
  formatBytes,
  getCompressionConcurrency,
  makeUniqueOutputFileNames,
  savingsPercent,
  shouldRequeueForGlobalSettings,
} from "./optimizeQueue";

const DEFAULT_SETTINGS: CompressionSettings = {
  targetFormat: "webp",
  quality: 85,
  removeGps: true,
};

interface OptimizePageProps {
  onUploadedToS3?: (focus: GalleryFocus) => void;
  activeProfile?: S3Profile;
  namingTemplate: string;
}

function contentTypeFor(format: string) {
  switch (format) {
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "heif":
      return "image/heif";
    default:
      return "application/octet-stream";
  }
}

export function OptimizePage({ activeProfile, namingTemplate, onUploadedToS3 }: OptimizePageProps) {
  const [items, setItems] = useState<OptimizeItem[]>([]);
  const [quality, setQuality] = useState(DEFAULT_SETTINGS.quality);
  // removeGps is always true since the encoder always strips metadata
  const removeGps = true;
  const [compareItemId, setCompareItemId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const activeTasks = useRef(new Set<string>());
  const optimizerRun = useRef<{ runId: string; outputDir: string } | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);
  const qualityRef = useRef(quality);
  const removeGpsRef = useRef(removeGps);

  useEffect(() => {
    return () => {
      window.clearTimeout(debounceRef.current);
    };
  }, []);

  const removeItem = (id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  };

  const inspectSingleItem = useCallback(async (itemId: string, sourcePath: string) => {
    setItems((current) =>
      current.map((ci) => (ci.id === itemId ? { ...ci, status: "inspecting" as const, error: undefined } : ci)),
    );

    try {
      const inspection: ImageInspection = await tauriApi.inspectImage({
        path: sourcePath,
        settings: { ...DEFAULT_SETTINGS, quality: qualityRef.current, removeGps: removeGpsRef.current },
      });

      const sourceFormat = inspection.sourceFormat ?? "unknown";
      const targetFormat = defaultTargetFormat(sourceFormat);
      const currentQuality = qualityRef.current;
      const currentRemoveGps = removeGpsRef.current;

      setItems((current) =>
        current.map((ci) =>
          ci.id === itemId
            ? {
                ...ci,
                fileName: inspection.fileName,
                sourceFormat,
                originalBytes: inspection.originalBytes,
                estimatedBytes: inspection.estimatedBytes ?? undefined,
                warning: inspection.warning ?? undefined,
                status: "queued" as const,
                settings: { targetFormat, quality: currentQuality, removeGps: currentRemoveGps },
              }
            : ci,
        ),
      );

      try {
        const thumb = await tauriApi.readThumbnail({ path: sourcePath, maxSize: 512 });
        setItems((current) =>
          current.map((ci) =>
            ci.id === itemId ? { ...ci, originalPreviewUrl: thumb.dataUrl } : ci,
          ),
        );
      } catch {
        // Thumbnails are best-effort
      }
    } catch (err) {
      setItems((current) =>
        current.map((ci) =>
          ci.id === itemId
            ? { ...ci, status: "failed" as const, error: err instanceof Error ? err.message : "Inspection failed" }
            : ci,
        ),
      );
    }
  }, []);

  const importImages = useCallback(async (paths: string[]) => {
    setImporting(true);
    setDropError(null);

    const pendingItems: OptimizeItem[] = paths.map((path) => ({
      id: crypto.randomUUID(),
      sourcePath: path,
      fileName: path.split("/").pop() ?? "unknown",
      sourceFormat: "unknown" as const,
      originalBytes: 0,
      status: "inspecting" as const,
      settings: { ...DEFAULT_SETTINGS, quality, removeGps },
      taskVersion: 0,
    }));

    setItems((current) => [...current, ...pendingItems]);

    for (const item of pendingItems) {
      await inspectSingleItem(item.id, item.sourcePath);
    }

    setImporting(false);
  }, [quality, removeGps, inspectSingleItem]);

  const handleChooseImages = async () => {
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "Images",
          extensions: ["jpg", "jpeg", "png", "webp", "avif", "heif", "heic"],
        },
      ],
    });

    if (!selected) return;

    const paths = Array.isArray(selected) ? selected : [selected];
    await importImages(paths);
  };

  const handleDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);

    const files = Array.from(event.dataTransfer.files);
    const paths: string[] = [];

    for (const file of files) {
      const filePath = (file as File & { path?: string }).path;
      if (filePath) {
        paths.push(filePath);
      }
    }

    if (paths.length === 0) {
      setDropError("Drag/drop file paths are unavailable; use Choose images.");
      return;
    }

    await importImages(paths);
  }, [importImages]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    try {
      getCurrentWebview()
        .onDragDropEvent(async (event) => {
          if (event.payload.type === "over") {
            setDragging(true);
            return;
          }

          if (event.payload.type === "drop") {
            setDragging(false);
            await importImages(event.payload.paths);
            return;
          }

          setDragging(false);
        })
        .then((cleanup) => {
          if (disposed) {
            cleanup();
            return;
          }
          unlisten = cleanup;
        })
        .catch(() => {});
    } catch {}

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [importImages]);

  // --- Bounded compression scheduler ---
  const runCompressionTask = useCallback(async (item: OptimizeItem, outputFileName: string) => {
    const itemId = item.id;
    const capturedVersion = item.taskVersion ?? 0;

    const getOutputDir = async () => {
      if (!optimizerRun.current) {
        optimizerRun.current = await tauriApi.createOptimizerRun();
      }
      return optimizerRun.current.outputDir;
    };

    const setItem = (updater: (item: OptimizeItem) => OptimizeItem) => {
      setItems((current) =>
        current.map((ci) => (ci.id === itemId ? updater(ci) : ci)),
      );
    };

    setItem((ci) => ({ ...ci, status: "compressing" }));

    try {
      const outputDir = await getOutputDir();
      const result = await tauriApi.compressImage({
        sourcePath: item.sourcePath,
        outputDir,
        outputFileName,
        settings: item.settings,
      });

      // Ignore stale results
      setItem((ci) => {
        if (ci.cancelling || (ci.taskVersion ?? 0) !== capturedVersion) return ci;
        return {
          ...ci,
          status: "loadingPreview",
          outputBytes: result.outputBytes,
          outputPath: result.outputPath,
          outputFileName: result.outputFileName,
          warning: result.warning ?? ci.warning,
        };
      });

      // Load compressed preview
      try {
        const thumb = await tauriApi.readThumbnail({ path: result.outputPath, maxSize: 512 });
        setItem((ci) => {
          if (ci.cancelling || (ci.taskVersion ?? 0) !== capturedVersion) return ci;
          return {
            ...ci,
            status: "compressed",
            compressedPreviewUrl: thumb.dataUrl,
          };
        });
      } catch {
        setItem((ci) => {
          if (ci.cancelling || (ci.taskVersion ?? 0) !== capturedVersion) return ci;
          return { ...ci, status: "compressed" };
        });
      }
    } catch (err) {
      setItem((ci) => {
        if ((ci.taskVersion ?? 0) !== capturedVersion) return ci;
        return {
          ...ci,
          status: "failed",
          error: err instanceof Error ? err.message : "Compression failed",
        };
      });
    } finally {
      activeTasks.current.delete(itemId);
    }
  }, []);

  useEffect(() => {
    const concurrency = getCompressionConcurrency(navigator.hardwareConcurrency);
    const availableSlots = concurrency - activeTasks.current.size;
    if (availableSlots <= 0) return;

    // Filter out items already being processed to prevent duplicate dispatch
    const queuedItems = items.filter(
      (item) => item.status === "queued" && !activeTasks.current.has(item.id),
    );

    if (queuedItems.length === 0) return;

    const outputNames = makeUniqueOutputFileNames(
      queuedItems.map((item) => ({
        id: item.id,
        fileName: item.fileName,
        targetFormat: item.settings.targetFormat,
      })),
    );

    const nextItems = queuedItems.slice(0, availableSlots);
    for (const item of nextItems) {
      activeTasks.current.add(item.id);
      void runCompressionTask(item, outputNames[item.id]);
    }
  }, [items, runCompressionTask]);

  // --- Global settings requeue with debounce ---
  const scheduleGlobalRequeue = (nextQuality: number, nextRemoveGps: boolean) => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      optimizerRun.current = null;
      setItems((current) =>
        current.map((item) =>
          shouldRequeueForGlobalSettings(item)
            ? {
                ...item,
                status: "queued",
                outputBytes: undefined,
                outputPath: undefined,
                outputFileName: undefined,
                compressedPreviewUrl: undefined,
                error: undefined,
                cancelling: false,
                taskVersion: (item.taskVersion ?? 0) + 1,
                settings: {
                  ...item.settings,
                  quality: nextQuality,
                  removeGps: nextRemoveGps,
                },
              }
            : item,
        ),
      );
    }, 400);
  };

  const handleQualityChange = (nextQuality: number) => {
    qualityRef.current = nextQuality;
    setQuality(nextQuality);
    scheduleGlobalRequeue(nextQuality, removeGpsRef.current);
  };

  // --- Per-item actions ---
  const updateFormat = (id: string, targetFormat: WritableImageFormat) => {
    optimizerRun.current = null;
    setItems((current) =>
      current.map((item) =>
        item.id === id && item.status !== "cancelled"
          ? {
              ...item,
              status: "queued",
              outputBytes: undefined,
              outputPath: undefined,
              outputFileName: undefined,
              compressedPreviewUrl: undefined,
              error: undefined,
              taskVersion: (item.taskVersion ?? 0) + 1,
              settings: { ...item.settings, targetFormat, quality, removeGps },
            }
          : item,
      ),
    );
  };

  const cancelItem = (id: string) => {
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              status: "cancelled",
              cancelling: item.status === "compressing",
              taskVersion: (item.taskVersion ?? 0) + 1,
            }
          : item,
      ),
    );
  };

  const retryItem = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (item && item.originalBytes === 0) {
      inspectSingleItem(id, item.sourcePath);
    } else {
      setItems((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                status: "queued" as const,
                error: undefined,
                cancelling: false,
                taskVersion: (item.taskVersion ?? 0) + 1,
                settings: { ...item.settings, quality, removeGps },
              }
            : item,
        ),
      );
    }
  };

  // --- Save and upload ---
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const handleSaveToLocal = async () => {
    setSaveError(null);
    setSaveSuccess(null);
    setSaving(true);
    try {
      const targetDir = await open({ directory: true });
      if (!targetDir) {
        setSaving(false);
        return;
      }

      const outputPaths = items
        .filter((item) => item.status === "compressed" && item.outputPath)
        .map((item) => item.outputPath as string);

      if (outputPaths.length === 0) {
        setSaveError("No compressed outputs to save.");
        setSaving(false);
        return;
      }

      const copied = await tauriApi.copyOutputsToDir({ outputPaths, targetDir: targetDir as string });
      setSaving(false);
      setSaveSuccess(`Saved ${copied.length} file(s) to ${targetDir}`);
    } catch (err) {
      setSaving(false);
      setSaveError(err instanceof Error ? err.message : "Failed to save files");
    }
  };

  const [uploadingItems, setUploadingItems] = useState<Set<string>>(new Set());
  const [uploadFailedItems, setUploadFailedItems] = useState<Map<string, string>>(new Map());
  const [uploadedKeys, setUploadedKeys] = useState<string[]>([]);
  const uploadCancelledRef = useRef(false);

  const uploadToS3 = async () => {
    if (!activeProfile) {
      setUploadError("Configure and select an S3 profile before uploading.");
      return;
    }
    setUploadError(null);
    setUploadFailedItems(new Map());
    uploadCancelledRef.current = false;
    const prefix = activeProfile.defaultPrefix || "images";
    const compressedItems = items.filter((item) => item.status === "compressed" && item.outputPath);
    if (compressedItems.length === 0) {
      setUploadError("No compressed outputs to upload.");
      return;
    }

    setUploadingItems(new Set(compressedItems.map((item) => item.id)));

    const newlyUploaded: string[] = [];
    const failed = new Map<string, string>();

    for (const item of compressedItems) {
      if (uploadCancelledRef.current) break;

      const outputFileName = item.outputFileName ?? "image.webp";
      const ext = item.settings.targetFormat;
      try {
        const { objectKey } = await namingApi.generateObjectKey({
          sourcePath: item.outputPath as string,
          outputFileName,
          prefix,
          namingTemplate,
          ext,
        });

        const result = await uploadApi.uploadObject({
          profile: activeProfile,
          sourcePath: item.outputPath as string,
          objectKey,
          contentType: contentTypeFor(ext),
          sourceFilename: item.fileName,
          outputFilename: outputFileName,
          originalBytes: item.originalBytes,
          targetFormat: ext,
        });

        newlyUploaded.push(result.key);
      } catch (err) {
        failed.set(item.id, err instanceof Error ? err.message : "Upload failed");
      }
    }

    setUploadingItems(new Set());
    setUploadFailedItems(failed);

    // Accumulate all uploaded keys across retries
    const allUploadedKeys = [...uploadedKeys, ...newlyUploaded];
    setUploadedKeys(allUploadedKeys);

    if (failed.size === 0) {
      onUploadedToS3?.({
        profileId: activeProfile.id,
        prefix,
        highlightedKeys: allUploadedKeys,
      });
    } else {
      setUploadError(
        `${failed.size} of ${compressedItems.length} upload(s) failed. Fix and retry.`,
      );
    }
  };

  const retryUploads = async () => {
    // Only retry items that failed, skip already uploaded ones
    if (!activeProfile) {
      setUploadError("Configure and select an S3 profile before uploading.");
      return;
    }
    setUploadError(null);
    uploadCancelledRef.current = false;
    const prefix = activeProfile.defaultPrefix || "images";
    const failedItems = items.filter(
      (item) => item.status === "compressed" && item.outputPath && uploadFailedItems.has(item.id),
    );
    if (failedItems.length === 0) {
      setUploadError("No failed uploads to retry.");
      return;
    }

    setUploadingItems(new Set(failedItems.map((item) => item.id)));

    const newlyUploaded: string[] = [];
    const stillFailed = new Map<string, string>();

    for (const item of failedItems) {
      if (uploadCancelledRef.current) break;

      const outputFileName = item.outputFileName ?? "image.webp";
      const ext = item.settings.targetFormat;
      try {
        const { objectKey } = await namingApi.generateObjectKey({
          sourcePath: item.outputPath as string,
          outputFileName,
          prefix,
          namingTemplate,
          ext,
        });

        const result = await uploadApi.uploadObject({
          profile: activeProfile,
          sourcePath: item.outputPath as string,
          objectKey,
          contentType: contentTypeFor(ext),
          sourceFilename: item.fileName,
          outputFilename: outputFileName,
          originalBytes: item.originalBytes,
          targetFormat: ext,
        });

        newlyUploaded.push(result.key);
      } catch (err) {
        stillFailed.set(item.id, err instanceof Error ? err.message : "Upload failed");
      }
    }

    setUploadingItems(new Set());
    setUploadFailedItems(stillFailed);

    // Accumulate all uploaded keys across retries
    const allUploadedKeys = [...uploadedKeys, ...newlyUploaded];
    setUploadedKeys(allUploadedKeys);

    if (stillFailed.size === 0) {
      onUploadedToS3?.({
        profile: activeProfile,
        prefix,
        highlightedKeys: allUploadedKeys,
      });
    } else {
      setUploadError(
        `${stillFailed.size} of ${failedItems.length} upload(s) failed. Fix and retry.`,
      );
    }
  };

  const compareItem = compareItemId ? items.find((i) => i.id === compareItemId) : undefined;

  return (
    <div className="grid gap-lg max-w-page">
      <header className="flex justify-between items-start gap-lg">
        <div>
          <h2 className="text-large-title font-bold text-on-surface text-balance">Optimize</h2>
          <p className="text-on-surface-variant mt-xs text-body text-pretty">Drop images to compress automatically.</p>
        </div>
        <div className="flex gap-md items-end flex-wrap">
          <span className="text-footnote text-on-surface-variant opacity-70">
            Metadata (including GPS) is removed during compression
          </span>
          <label className="grid gap-xs min-w-[220px] text-footnote font-medium text-on-surface-variant">
            Quality {quality}%
            <Slider aria-label="Quality" value={quality} onValueChange={handleQualityChange} min={1} max={100} />
          </label>
        </div>
      </header>

      <section
        data-testid="drop-zone"
        className={cn(
          "border-2 border-dashed rounded-lg bg-surface-container-low p-2xl px-xl text-center text-on-surface-variant text-callout",
          "transition-[border-color,background-color] duration-150 ease-out cursor-pointer",
          "hover:border-outline hover:bg-surface-container",
          dragging && "border-primary bg-[rgba(255,149,0,0.08)] border-solid",
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className="text-headline font-medium text-on-surface mb-sm">Drop images here</div>
        <div className="text-footnote text-on-surface-variant opacity-70">
          or{" "}
          <button className={btnTertiary} type="button" onClick={handleChooseImages} disabled={importing}>
            Choose images
          </button>
        </div>
      </section>

      {dropError && <p className="text-error text-footnote" role="alert">{dropError}</p>}
      {importing && (
        <section className="grid gap-sm grid-cols-[repeat(auto-fill,minmax(220px,1fr))]" aria-label="Importing images">
          {Array.from({ length: 3 }, (_, i) => (
            <article key={i} className="relative bg-surface-container border border-outline-variant rounded-md flex flex-col gap-sm p-md">
              <div className="w-full aspect-square rounded-[calc(var(--radius-md)-2px)] overflow-hidden bg-surface-container-high flex items-center justify-center" aria-hidden="true" />
              <div className="flex flex-col gap-0.5 min-w-0">
                <strong className="h-[var(--text-callout)] bg-surface-container-high rounded-xs">&nbsp;</strong>
                <p className="h-[var(--text-footnote)] bg-surface-container-high rounded-xs mt-1">&nbsp;</p>
              </div>
            </article>
          ))}
        </section>
      )}

      <section className="grid gap-sm grid-cols-[repeat(auto-fill,minmax(220px,1fr))]" aria-label="Images to optimize">
        {items.map((item) => (
          <article className="group relative bg-surface-container border border-outline-variant rounded-md flex flex-col gap-sm p-md transition-[border-color,background-color] duration-150 ease-out hover:border-outline hover:bg-surface-container-high" key={item.id}>
            <button
              type="button"
              className="absolute top-1 right-1 size-[22px] border-none rounded-full bg-surface-container-high text-on-surface-variant text-base leading-none p-0 cursor-pointer flex items-center justify-center opacity-0 transition-[opacity,background] duration-150 group-hover:opacity-100 focus-within:opacity-100 hover:bg-outline hover:text-on-surface"
              aria-label={`Remove ${item.fileName} from queue`}
              onClick={() => removeItem(item.id)}
            >
              x
            </button>
            <div className="w-full aspect-square rounded-[calc(var(--radius-md)-2px)] overflow-hidden bg-surface-container-low flex items-center justify-center">
              {item.status === "compressed" && item.compressedPreviewUrl ? (
                <button type="button" aria-label={`Compare ${item.fileName}`} onClick={() => setCompareItemId(item.id)}>
                  <img src={item.compressedPreviewUrl} alt="" loading="lazy" className="w-full h-full object-cover block" />
                </button>
              ) : item.originalPreviewUrl ? (
                <img src={item.originalPreviewUrl} alt="" loading="lazy" className="w-full h-full object-cover block" />
              ) : (
                <span className="w-full h-full bg-surface-container-high" aria-hidden="true" />
              )}
            </div>
            <div className="flex flex-col gap-0.5 min-w-0">
              <strong className="text-callout font-semibold text-on-surface overflow-hidden text-ellipsis whitespace-nowrap">{item.fileName}</strong>
              {item.error ? (
                <p className="text-error text-caption mt-0.5">{item.error}</p>
              ) : item.status === "cancelled" ? (
                <p className="text-on-surface-variant mt-0.5 text-footnote text-pretty">Cancelled</p>
              ) : item.status === "compressing" || item.status === "loadingPreview" ? (
                <p className="text-on-surface-variant mt-0.5 text-footnote text-pretty tabular-nums">Compressing...</p>
              ) : item.status === "compressed" ? (
                <p className="text-on-surface-variant mt-0.5 text-footnote text-pretty tabular-nums">
                  {formatBytes(item.originalBytes)} {String.fromCodePoint(0x2192)} {formatBytes(item.outputBytes ?? 0)}{" "}
                  ({savingsPercent(item.originalBytes, item.outputBytes ?? 0)}% saved)
                </p>
              ) : item.originalBytes > 0 ? (
                <p className="text-on-surface-variant mt-0.5 text-footnote text-pretty tabular-nums">
                  {item.sourceFormat.toUpperCase()} {String.fromCodePoint(0x2192)} {item.settings.targetFormat.toUpperCase()} |{" "}
                  {formatBytes(item.originalBytes)}
                </p>
              ) : null}
              {item.warning && <p className="text-on-tertiary text-caption mt-0.5">{item.warning}</p>}
              {item.settings.targetFormat === "png" && (
                <p className="text-on-tertiary text-caption mt-0.5">Quality does not apply to PNG output.</p>
              )}
              {item.status !== "inspecting" && item.status !== "cancelled" && !item.error && (
                <label className="flex flex-col mt-xs text-footnote text-on-surface-variant">
                  <select
                    aria-label={`Format for ${item.fileName}`}
                    value={item.settings.targetFormat}
                    onChange={(event) => updateFormat(item.id, event.target.value as WritableImageFormat)}
                  >
                    {AVAILABLE_OUTPUT_FORMATS.map((format) => (
                      <option key={format} value={format}>
                        {format.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {uploadFailedItems.has(item.id) && (
                <p className="text-error text-caption mt-0.5">{uploadFailedItems.get(item.id)}</p>
              )}
              {uploadingItems.has(item.id) && (
                <p className="text-on-surface-variant text-caption mt-0.5">Uploading...</p>
              )}
              {(item.status === "inspecting" || item.status === "queued" || item.status === "compressing" || item.status === "loadingPreview") && (
                <button className={btnTertiary} type="button" aria-label={`Cancel ${item.fileName}`} onClick={() => cancelItem(item.id)}>Cancel</button>
              )}
              {(item.status === "failed" || item.status === "cancelled") && (
                <button className={btnTertiary} type="button" aria-label={`Retry ${item.fileName}`} onClick={() => retryItem(item.id)}>Retry</button>
              )}
              {(item.status === "compressed" || item.status === "failed" || item.status === "cancelled") && (
                <button className={btnTertiary} type="button" aria-label={`Remove ${item.fileName}`} onClick={() => removeItem(item.id)}>Remove</button>
              )}
            </div>
          </article>
        ))}
      </section>

      {saving && <p className="text-on-surface-variant text-footnote">Saving files...</p>}
      {uploadingItems.size > 0 && <p className="text-on-surface-variant text-footnote">Uploading {uploadingItems.size} image(s)...</p>}
      {uploadError && <p className="text-error text-footnote">{uploadError}</p>}
      {saveError && <p className="text-error text-footnote">{saveError}</p>}
      {saveSuccess && <p className="text-on-surface-variant text-footnote">{saveSuccess}</p>}

      {items.some((item) => item.status === "compressed") && (
        <div className="flex gap-sm flex-wrap">
          <button className={btnPrimary} type="button" onClick={handleSaveToLocal} disabled={saving || uploadingItems.size > 0}>Save to local folder</button>
          {uploadFailedItems.size > 0 ? (
            <button className={btnPrimary} type="button" onClick={retryUploads} disabled={saving || uploadingItems.size > 0}>
              Retry {uploadFailedItems.size} failed upload(s)
            </button>
          ) : (
            <button className={btnPrimary} type="button" onClick={uploadToS3} disabled={saving || uploadingItems.size > 0}>Upload to S3</button>
          )}
        </div>
      )}

      {compareItem && (
        <Dialog
          open
          onOpenChange={(open) => { if (!open) setCompareItemId(null); }}
          title={`Compare ${compareItem.fileName}`}
        >
          <div className="flex flex-col gap-xs mb-lg text-caption text-on-surface-variant">
            <p>Quality: {compareItem.settings.quality}</p>
            <p>Metadata: Removed during compression</p>
            <p>Output format: {compareItem.settings.targetFormat}</p>
          </div>
          <div className="grid grid-cols-2 gap-lg">
            <div>
              <p className="text-footnote font-medium text-on-surface-variant mb-sm">Original</p>
              {compareItem.originalPreviewUrl && (
                <img src={compareItem.originalPreviewUrl} alt="" className="w-full rounded-md" />
              )}
              <p className="text-caption text-on-surface-variant mt-xs">{formatBytes(compareItem.originalBytes)}</p>
            </div>
            <div>
              <p className="text-footnote font-medium text-on-surface-variant mb-sm">Compressed</p>
              {compareItem.compressedPreviewUrl && (
                <img src={compareItem.compressedPreviewUrl} alt="" className="w-full rounded-md" />
              )}
              <p className="text-caption text-on-surface-variant mt-xs">{formatBytes(compareItem.outputBytes ?? 0)}</p>
            </div>
          </div>
          <Dialog.Close className={cn(btnSecondary, "mt-lg")}>Close</Dialog.Close>
        </Dialog>
      )}
    </div>
  );
}
