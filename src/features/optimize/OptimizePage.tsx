import { useCallback, useEffect, useRef, useState } from "react";
import { open, onFileDrop, onImagesOpened } from "@/platform/desktop";
import type { CompressionSettings, ImageInspection, OptimizeItem, S3Profile, WritableImageFormat } from "../../types";
import type { GalleryFocus } from "../../state/appState";
import { imageApi } from "../../api/backend";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { OptimizeWorkspace, type CompressionPreset } from "./OptimizeWorkspace";
import { fileNameFromPath } from "../../lib/path";
import { errorMessage } from "../../lib/error";
import { extensionsFor } from "../../lib/imageFormats";
import {
  defaultTargetFormat,
  formatBytes,
  getCompressionConcurrency,
  isCurrentCompressionOutput,
  makeUniqueOutputFileNames,
  trackDispatchedNames,
  shouldRequeueForGlobalSettings,
} from "./optimizeQueue";
import { ImageComparison } from "./ImageComparison";
import { useOptimizeUploads } from "./useOptimizeUploads";

const DEFAULT_SETTINGS: CompressionSettings = {
  targetFormat: "jpg",
  quality: 85,
  removeGps: true,
};

function losslessTarget(format: WritableImageFormat, quality: number, bitDepth = 8, frames = 1): WritableImageFormat {
  if (format === "jxl" && quality === 100) {
    if (frames > 1) return "webp";
    if (bitDepth > 8) return "png";
  }
  return format;
}

function cancelBackendTask(item: OptimizeItem) {
  void imageApi.cancelImageTask({ taskId: `${item.id}:${item.taskVersion ?? 0}` }).catch(() => {
    // Task versions still discard late results if the bridge is shutting down.
  });
}

interface OptimizePageProps {
  isActive?: boolean;
  onOpenGallery?: () => void;
  onUploadedToS3?: (focus: GalleryFocus) => void;
  activeProfile?: S3Profile;
  namingTemplate: string;
}

export function OptimizePage({ activeProfile, namingTemplate, onUploadedToS3, isActive = true, onOpenGallery }: OptimizePageProps) {
  const [uploadedFocus, setUploadedFocus] = useState<(GalleryFocus & { destination: string }) | null>(null);
  const [items, setItems] = useState<OptimizeItem[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [quality, setQuality] = useState(DEFAULT_SETTINGS.quality);
  const [maxDimension, setMaxDimension] = useState(0);
  const maxDimensionRef = useRef(0);
  const [compareItemId, setCompareItemId] = useState<string | null>(null);
  const [firstFrameRequest, setFirstFrameRequest] = useState<{ id: string; format: WritableImageFormat } | null>(null);
  const [importCount, setImportCount] = useState(0);
  const importing = importCount > 0;
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [preset, setPreset] = useState<CompressionPreset>("original");
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const importedPaths = useRef(new Set<string>());
  const importGeneration = useRef(0);
  const defaultFormat = useRef<WritableImageFormat | "original">("original");
  const [saving, setSaving] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const activeTasks = useRef(new Set<string>());
  // Tracks how many times each preferred (base) output name has been dispatched
  // across scheduler runs, keyed by preferred name (e.g. "photo.webp" → 2).
  // This matches the key space that makeUniqueOutputFileNames expects.
  const preferredNameCounts = useRef(new Map<string, number>());
  const optimizerRun = useRef<Promise<{ runId: string; outputDir: string }> | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);
  const pendingQualityRef = useRef<number | undefined>(undefined);
  const qualityRef = useRef(quality);
  const uploads = useOptimizeUploads({
    activeProfile,
    currentQuality: quality,
    items,
    namingTemplate,
    onUploadedToS3: (focus) => {
      setUploadedFocus({ ...focus, destination: activeProfile ? `${activeProfile.name} · ${activeProfile.bucket} / ${focus.prefix}` : focus.profileId ?? "S3" });
      onUploadedToS3?.(focus);
    },
  });

  const canMutateQueue = useCallback(() => !saving && uploads.canMutateQueue(), [saving, uploads.canMutateQueue]);

  useEffect(() => {
    return () => {
      window.clearTimeout(debounceRef.current);
      itemsRef.current.forEach(cancelBackendTask);
    };
  }, []);

  const removeItem = (id: string) => {
    if (!canMutateQueue()) return;
    setUploadedFocus(null);
    const item = items.find((entry) => entry.id === id);
    if (item) {
      cancelBackendTask(item);
      importedPaths.current.delete(item.sourcePath);
    }
    setItems((current) => current.filter((item) => item.id !== id));
    uploads.forgetItem(id);
  };

  const inspectSingleItem = useCallback(async (itemId: string, sourcePath: string, capturedVersion: number) => {
    setItems((current) =>
      current.map((ci) =>
        ci.id === itemId && (ci.taskVersion ?? 0) === capturedVersion
          ? { ...ci, status: "inspecting" as const, error: undefined }
          : ci,
      ),
    );

    try {
      const inspection: ImageInspection = await imageApi.inspectImage({
        taskId: `${itemId}:${capturedVersion}`,
        path: sourcePath,
        settings: { ...DEFAULT_SETTINGS, quality: qualityRef.current, removeGps: true },
      });

      const sourceFormat = inspection.sourceFormat ?? "unknown";
      const selectedFormat = defaultFormat.current === "original" ? defaultTargetFormat(sourceFormat) : defaultFormat.current;
      const animated = inspection.animated ?? (inspection.frameCount ?? 1) > 1;
      const targetFormat = animated && sourceFormat === "webp" ? "webp" : losslessTarget(selectedFormat, qualityRef.current, inspection.bitDepth, inspection.frameCount);
      const currentQuality = qualityRef.current;
      const currentRemoveGps = true;

      setItems((current) =>
        current.map((ci) =>
          ci.id === itemId && (ci.taskVersion ?? 0) === capturedVersion
            ? {
                ...ci,
                fileName: inspection.fileName,
                sourceFormat,
                originalBytes: inspection.originalBytes,
                originalWidth: inspection.width,
                originalHeight: inspection.height,
                originalBitDepth: inspection.bitDepth,
                originalFrameCount: inspection.frameCount,
                originalAnimated: animated,
                originalHDR: inspection.hdr,
                sourceWarning: inspection.warning ?? undefined,
                estimatedBytes: inspection.estimatedBytes ?? undefined,
                warning: inspection.warning ?? undefined,
                status: "queued" as const,
                settings: { targetFormat, quality: currentQuality, maxDimension: maxDimensionRef.current || undefined, removeGps: currentRemoveGps },
              }
            : ci,
        ),
      );

      try {
        const thumb = await imageApi.readThumbnail({ taskId: `${itemId}:${capturedVersion}`, path: sourcePath, maxSize: 1024 });
        setItems((current) =>
          current.map((ci) =>
            ci.id === itemId && (ci.taskVersion ?? 0) === capturedVersion
              ? { ...ci, originalPreviewUrl: thumb.dataUrl }
              : ci,
          ),
        );
      } catch {
        // Thumbnails are best-effort
      }
    } catch (err) {
      setItems((current) =>
        current.map((ci) =>
          ci.id === itemId && (ci.taskVersion ?? 0) === capturedVersion
            ? { ...ci, status: "failed" as const, error: errorMessage(err, "Inspection failed") }
            : ci,
        ),
      );
    }
  }, []);

  const importImages = useCallback(async (paths: string[]) => {
    if (!canMutateQueue()) return;
    setUploadedFocus(null);
    setDropError(null);
    const newPaths = [...new Set(paths)].filter((path) => !importedPaths.current.has(path));
    const skipped = paths.length - newPaths.length;
    setImportNotice(skipped ? `${skipped} image(s) already in this batch; duplicates skipped.` : null);
    if (!newPaths.length) return;
    newPaths.forEach((path) => importedPaths.current.add(path));
    const generation = importGeneration.current;
    setImportCount((count) => count + 1);

    const pendingItems: OptimizeItem[] = newPaths.map((path) => ({
      id: crypto.randomUUID(),
      sourcePath: path,
      fileName: fileNameFromPath(path),
      sourceFormat: "unknown" as const,
      originalBytes: 0,
      status: "inspecting" as const,
      settings: { ...DEFAULT_SETTINGS, quality, removeGps: true },
      taskVersion: 0,
    }));

    setItems((current) => [...current, ...pendingItems]);
    setSelectedItemId((current) => current ?? pendingItems[0].id);
    let cursor = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(2, pendingItems.length) }, async () => {
        while (generation === importGeneration.current && cursor < pendingItems.length) {
          const item = pendingItems[cursor++];
          await inspectSingleItem(item.id, item.sourcePath, item.taskVersion ?? 0);
        }
      }));
    } finally {
      setImportCount((count) => count - 1);
    }
  }, [quality, inspectSingleItem, canMutateQueue]);

  const handleChooseImages = async () => {
    if (!canMutateQueue()) return;
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "Images", extensions: extensionsFor("compressImport") }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await importImages(paths);
    } catch (error) {
      setDropError(errorMessage(error, "Could not open the image picker. Try dropping files instead."));
    }
  };

  const handleDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);

    if (!canMutateQueue()) return;

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
  }, [importImages, canMutateQueue]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
  }, []);

  const importImagesRef = useRef(importImages);
  importImagesRef.current = importImages;

  useEffect(() => onImagesOpened((paths) => {
    void importImagesRef.current(paths);
  }), []);

  useEffect(() => {
    if (!isActive) return;
    const unsubscribe = onFileDrop((paths) => {
      setDragging(false);
      void importImages(paths);
    });
    return unsubscribe;
  }, [importImages, isActive]);

  // --- Bounded compression scheduler ---
  const runCompressionTask = useCallback(async (item: OptimizeItem, outputFileName: string) => {
    const itemId = item.id;
    const capturedVersion = item.taskVersion ?? 0;

    const getOutputDir = async () => {
      const run = optimizerRun.current ?? imageApi.createOptimizerRun();
      optimizerRun.current = run;
      try {
        return (await run).outputDir;
      } catch (error) {
        if (optimizerRun.current === run) optimizerRun.current = null;
        throw error;
      }
    };

    const setItem = (updater: (item: OptimizeItem) => OptimizeItem) => {
      setItems((current) =>
        current.map((ci) => (ci.id === itemId ? updater(ci) : ci)),
      );
    };

    setItem((ci) => ({ ...ci, status: "compressing" }));

    try {
      const outputDir = await getOutputDir();
      if (capturedVersion > 0 && !item.originalPreviewUrl) {
        try {
          const original = await imageApi.readThumbnail({ taskId: `${itemId}:${capturedVersion}`, path: item.sourcePath, maxSize: 1024 });
          setItem((ci) => (ci.taskVersion ?? 0) === capturedVersion && !ci.cancelling ? { ...ci, originalPreviewUrl: original.dataUrl } : ci);
        } catch {
          // A source preview remains optional; full-resolution comparison can retry.
        }
      }
      const result = await imageApi.compressImage({
        taskId: `${itemId}:${capturedVersion}`,
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
          outputWidth: result.width,
          outputHeight: result.height,
          warning: result.warning ?? ci.warning,
        };
      });

      // Load compressed preview
      try {
        const thumb = await imageApi.readThumbnail({ taskId: `${itemId}:${capturedVersion}`, path: result.outputPath, maxSize: 1024 });
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
          error: errorMessage(err, "Compression failed"),
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
      preferredNameCounts.current,
    );

    const nextItems = queuedItems.slice(0, availableSlots);
    // Track preferred name counts only for items actually dispatched, so
    // subsequent scheduler runs produce correct suffixes.
    trackDispatchedNames(
      nextItems.map((item) => ({ fileName: item.fileName, targetFormat: item.settings.targetFormat })),
      preferredNameCounts.current,
    );
    for (const item of nextItems) {
      activeTasks.current.add(item.id);
      void runCompressionTask(item, outputNames[item.id]);
    }
  }, [items, runCompressionTask]);

  // --- Global settings requeue with debounce ---
  const applyGlobalRequeue = useCallback((nextQuality: number, format?: WritableImageFormat | "original") => {
    if (!canMutateQueue()) return false;

    setUploadedFocus(null);
    pendingQualityRef.current = undefined;
    optimizerRun.current = null;
    preferredNameCounts.current.clear();
    uploads.reset();
    itemsRef.current.filter(shouldRequeueForGlobalSettings).forEach(cancelBackendTask);
    setItems((current) =>
      current.map((item): OptimizeItem => {
        if (item.status === "inspecting") return item;
        const animationMode = format ? undefined : item.settings.animationMode;
        const targetFormat = format && item.originalAnimated && item.sourceFormat === "webp" ? "webp" : losslessTarget(format === "original" ? defaultTargetFormat(item.sourceFormat) : format ?? item.settings.targetFormat, nextQuality, item.originalBitDepth, animationMode === "firstFrame" ? 1 : item.originalFrameCount);
        const settings: CompressionSettings = {
          ...item.settings,
          animationMode,
          targetFormat,
          quality: nextQuality,
          maxDimension: maxDimensionRef.current || undefined,
          removeGps: true,
        };
        if (!shouldRequeueForGlobalSettings(item)) return { ...item, settings };
        return {
          ...item,
          status: "queued",
          outputBytes: undefined,
          outputPath: undefined,
          outputFileName: undefined,
          compressedPreviewUrl: undefined,
          error: undefined,
          cancelling: false,
          taskVersion: (item.taskVersion ?? 0) + 1,
          settings,
        };
      }),
    );
    return true;
  }, [canMutateQueue, uploads.reset]);

  const scheduleGlobalRequeue = (nextQuality: number) => {
    pendingQualityRef.current = nextQuality;
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      if (!canMutateQueue()) return;

      applyGlobalRequeue(nextQuality);
    }, 400);
  };

  useEffect(() => {
    if (uploads.isUploading) {
      window.clearTimeout(debounceRef.current);
      return;
    }

    const pendingQuality = pendingQualityRef.current;
    if (pendingQuality !== undefined) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        applyGlobalRequeue(pendingQuality);
      }, 400);
    }
  }, [applyGlobalRequeue, uploads.isUploading]);

  const handleQualityChange = (nextQuality: number) => {
    if (!canMutateQueue()) return;
    qualityRef.current = nextQuality;
    setQuality(nextQuality);
    setPreset("custom");
    scheduleGlobalRequeue(nextQuality);
  };

  const applyPreset = (next: Exclude<CompressionPreset, "custom">) => {
    if (!canMutateQueue()) return;
    const settings = {
      original: { quality: 85, format: "original" as const },
      balanced: { quality: 82, format: "webp" as const },
      small: { quality: 55, format: "avif" as const },
      lossless: { quality: 100, format: "jxl" as const },
    }[next];
    window.clearTimeout(debounceRef.current);
    pendingQualityRef.current = undefined;
    defaultFormat.current = settings.format;
    if (next === "lossless") {
      maxDimensionRef.current = 0;
      setMaxDimension(0);
    }
    qualityRef.current = settings.quality;
    setQuality(settings.quality);
    setPreset(next);
    applyGlobalRequeue(settings.quality, settings.format);
  };

  const changeMaxDimension = (value: number) => {
    if (!canMutateQueue()) return;
    window.clearTimeout(debounceRef.current);
    pendingQualityRef.current = undefined;
    maxDimensionRef.current = value;
    setMaxDimension(value);
    setPreset("custom");
    applyGlobalRequeue(qualityRef.current);
  };

  const clearBatch = () => {
    if (!canMutateQueue()) return;
    window.clearTimeout(debounceRef.current);
    pendingQualityRef.current = undefined;
    importGeneration.current += 1;
    importedPaths.current.clear();
    itemsRef.current.forEach(cancelBackendTask);
    setItems([]);
    setSelectedItemId(null);
    setCompareItemId(null);
    setFirstFrameRequest(null);
    setUploadedFocus(null);
    setImportNotice(null);
    setSaveSuccess(null);
    setSaveError(null);
    uploads.reset();
    optimizerRun.current = null;
    preferredNameCounts.current.clear();
  };

  // --- Per-item actions ---
  const updateFormat = (id: string, targetFormat: WritableImageFormat, animationMode?: CompressionSettings["animationMode"]) => {
    if (!canMutateQueue()) return;
    const source = itemsRef.current.find((item) => item.id === id);
    if (!source || source.status === "cancelled" || source.status === "inspecting") return;
    const mode = animationMode ?? source.settings.animationMode;
    if (source.originalAnimated && mode !== "firstFrame" && (source.sourceFormat !== "webp" || targetFormat !== "webp")) {
      setFirstFrameRequest({ id, format: targetFormat });
      return;
    }
    setPreset("custom");
    setSaveSuccess(null);
    setUploadedFocus(null);
    optimizerRun.current = null;
    preferredNameCounts.current.clear();
    uploads.forgetItem(id);
    const previous = itemsRef.current.find((item) => item.id === id);
    if (previous) cancelBackendTask(previous);
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
              settings: { ...item.settings, targetFormat, animationMode: mode, quality, maxDimension: maxDimensionRef.current || undefined, removeGps: true },
            }
          : item,
      ),
    );
  };

  const cancelItem = (id: string) => {
    if (!canMutateQueue()) return;
    const item = itemsRef.current.find((item) => item.id === id);
    if (item) cancelBackendTask(item);
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
    if (!canMutateQueue()) return;
    const item = items.find((i) => i.id === id);
    if (item && item.originalBytes === 0) {
      const nextTaskVersion = (item.taskVersion ?? 0) + 1;
      setItems((current) =>
        current.map((currentItem) =>
          currentItem.id === id
            ? {
                ...currentItem,
                status: "inspecting" as const,
                error: undefined,
                cancelling: false,
                taskVersion: nextTaskVersion,
              }
            : currentItem,
        ),
      );
      void inspectSingleItem(id, item.sourcePath, nextTaskVersion);
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
                settings: { ...item.settings, quality, maxDimension: maxDimensionRef.current || undefined, removeGps: true },
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
        .filter((item) => isCurrentCompressionOutput(item, quality))
        .map((item) => item.outputPath);

      if (outputPaths.length === 0) {
        setSaveError("No compressed outputs to save.");
        setSaving(false);
        return;
      }

      const copied = await imageApi.copyOutputsToDir({ outputPaths, targetDir: targetDir as string });
      setSaving(false);
      setSaveSuccess(`Saved ${copied.length} file(s) to ${targetDir}`);
    } catch (err) {
      setSaving(false);
      setSaveError(errorMessage(err, "Failed to save files"));
    }
  };

  const readyItems = items.filter((item) => isCurrentCompressionOutput(item, quality));
  const readyOriginalBytes = readyItems.reduce((sum, item) => sum + item.originalBytes, 0);
  const readyOutputBytes = readyItems.reduce((sum, item) => sum + (item.outputBytes ?? 0), 0);
  const failedItemCount = items.filter((item) => item.status === "failed").length;
  const compareItem = compareItemId ? items.find((i) => i.id === compareItemId) : undefined;

  return (
    <div className="bench">
      <header className="bench-head">
        <div>
          <h2>Prepare images</h2>
          <p className="bench-sub">Preview, compare, and export. Originals stay untouched.</p>
        </div>
      </header>

      {(dropError || importNotice) && (
        <div className="bench-notices">
          {dropError && (
            <Alert variant="destructive">
              <AlertDescription>{dropError}</AlertDescription>
            </Alert>
          )}
          {importNotice && <p role="status">{importNotice}</p>}
        </div>
      )}

      <OptimizeWorkspace
        items={items}
        selectedId={selectedItemId}
        onSelect={setSelectedItemId}
        quality={quality}
        maxDimension={maxDimension}
        onMaxDimension={changeMaxDimension}
        preset={preset}
        onPreset={applyPreset}
        onQuality={handleQualityChange}
        locked={saving || uploads.isUploading}
        onClear={clearBatch}
        onCancel={cancelItem}
        onCompare={(id) => { setSelectedItemId(id); setCompareItemId(id); }}
        onFormat={updateFormat}
        onAnimationMode={(id, mode) => {
          const item = itemsRef.current.find((entry) => entry.id === id);
          if (item) updateFormat(id, mode === "preserve" && item.sourceFormat === "webp" ? "webp" : item.settings.targetFormat, mode);
        }}
        onRemove={removeItem}
        onRetry={retryItem}
        uploadFailure={uploads.failureMessageFor}
        isUploading={uploads.isItemUploading}
        onChooseImages={handleChooseImages}
        chooseDisabled={importing || saving || uploads.isUploading}
        dragging={dragging}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      />

      {items.length > 0 && (
        <section aria-label="Compression actions" className="bench-actions">
          <div className="action-layout">
            <div className="action-summary">
              <p className="action-totals" role="status">
                <strong>{readyItems.length} of {items.length} ready</strong>
                {failedItemCount > 0 ? `, ${failedItemCount} failed` : ""}
                {readyItems.length > 0 && `, ${formatBytes(readyOriginalBytes)} → ${formatBytes(readyOutputBytes)}, ${formatBytes(Math.abs(readyOriginalBytes - readyOutputBytes))} ${readyOutputBytes > readyOriginalBytes ? "larger" : "saved"}`}
              </p>
              <p className="action-destination" aria-label="Upload destination">
                {uploads.uploadProfile
                  ? `Upload destination: ${uploads.uploadProfile.name} · ${uploads.uploadProfile.bucket} / ${uploads.uploadProfile.defaultPrefix || "images"}`
                  : "Set an upload destination in Settings. Your compressed images will stay here."}
              </p>
            </div>
            <div className="action-buttons">
              {items.some((item) => ["inspecting", "queued", "compressing", "loadingPreview"].includes(item.status)) && <Button type="button" size="sm" variant="ghost" disabled={saving || uploads.isUploading} onClick={() => {
                importGeneration.current += 1;
                itemsRef.current.filter((item) => ["inspecting", "queued", "compressing", "loadingPreview"].includes(item.status)).forEach(cancelBackendTask);
                setItems((current) => current.map((item) => ["inspecting", "queued", "compressing", "loadingPreview"].includes(item.status) ? { ...item, status: "cancelled", cancelling: true, taskVersion: (item.taskVersion ?? 0) + 1 } : item));
              }}>Stop batch</Button>}
              {items.some((item) => item.status === "failed" || item.status === "cancelled") && <Button type="button" size="sm" variant="ghost" disabled={saving || uploads.isUploading} onClick={() => items.filter((item) => item.status === "failed" || item.status === "cancelled").forEach((item) => retryItem(item.id))}>Retry unfinished</Button>}
              {items.some((item) => isCurrentCompressionOutput(item, quality)) && (
                <>
                  <Button type="button" variant="outline" onClick={handleSaveToLocal} disabled={saving || uploads.isUploading}>Save to local folder</Button>
                  {uploads.failedUploadCount > 0 && (
                    <Button type="button" variant="outline" onClick={uploads.retryUploads} disabled={saving || uploads.isUploading}>
                      Retry {uploads.failedUploadCount} failed upload(s)
                      {uploads.hasCollisionFailure ? " with new key" : ""}
                    </Button>
                  )}
                  {uploads.newUploadItemCount > 0 && (
                    <Button type="button" onClick={uploads.uploadToS3} disabled={saving || uploads.isUploading}>
                      {uploads.failedUploadCount > 0
                        ? `Upload ${uploads.newUploadItemCount} new image(s) to S3`
                        : "Upload to S3"}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>

          {(saving || uploads.uploadingItemCount > 0 || uploads.uploadError || saveError || uploadedFocus || saveSuccess) && (
            <div className="action-extra">
              {saving && <p role="status">Saving files...</p>}
              {uploads.uploadingItemCount > 0 && <p role="status">Uploading {uploads.uploadingItemCount} image(s)...</p>}
              {uploads.uploadError && (
                <Alert variant="destructive">
                  <AlertDescription>{uploads.uploadError}</AlertDescription>
                </Alert>
              )}
              {saveError && (
                <Alert variant="destructive">
                  <AlertDescription>{saveError}</AlertDescription>
                </Alert>
              )}
              {uploadedFocus && (
                <div className="upload-feedback" role="status">
                  <p title={`Uploaded to ${uploadedFocus.destination}`}>Uploaded {uploadedFocus.highlightedKeys.length} image(s) to {uploadedFocus.destination}. Local results retained.</p>
                  {onOpenGallery && <Button variant="outline" size="sm" onClick={onOpenGallery}>View uploaded images</Button>}
                </div>
              )}
              {saveSuccess && <p role="status">{saveSuccess}</p>}
            </div>
          )}
        </section>
      )}

      {firstFrameRequest && isActive && (
        <Dialog open onOpenChange={(open) => { if (!open) setFirstFrameRequest(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Export the first frame?</DialogTitle>
              <DialogDescription>This exports a still image as {firstFrameRequest.format.toUpperCase()}. The remaining frames are excluded from this output. Your original animation stays untouched.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Keep animation</DialogClose>
              <Button onClick={() => {
                updateFormat(firstFrameRequest.id, firstFrameRequest.format, "firstFrame");
                setFirstFrameRequest(null);
              }}>Export first frame</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {compareItem && isActive && (
        <Dialog
          open
          onOpenChange={(open) => { if (!open) setCompareItemId(null); }}
        >
          <DialogContent className="sm:max-w-5xl max-h-[90dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{`Compare ${compareItem.fileName}`}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <p>Quality: {compareItem.settings.quality}</p>
              <p>Metadata: Removed during compression</p>
              <p>Output format: {compareItem.settings.targetFormat}</p>
              {compareItem.originalHDR && <p>HDR original shown with the same SDR tone mapping as the output.</p>}
              {compareItem.originalAnimated && <p>{compareItem.settings.animationMode === "firstFrame" ? "First frame only exported." : "Animation retained in WebP output; comparison shows the first frame."}</p>}
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
              Size: {formatBytes(compareItem.originalBytes)} → {formatBytes(compareItem.outputBytes ?? 0)}
            </p>
            {compareItem.outputPath && (
              <ImageComparison originalPath={compareItem.sourcePath} compressedPath={compareItem.outputPath} />
            )}
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
