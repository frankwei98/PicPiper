import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { CompressionSettings, ImageInspection, OptimizeItem, S3Profile, WritableImageFormat } from "../../types";
import type { GalleryFocus } from "../../state/appState";
import { tauriApi } from "../../api/tauri";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
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
import { OptimizeItemCard } from "./OptimizeItemCard";
import { useOptimizeUploads } from "./useOptimizeUploads";

const DEFAULT_SETTINGS: CompressionSettings = {
  targetFormat: "webp",
  quality: 85,
  removeGps: true,
};

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
  const [quality, setQuality] = useState(DEFAULT_SETTINGS.quality);
  const [compareItemId, setCompareItemId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const activeTasks = useRef(new Set<string>());
  // Tracks how many times each preferred (base) output name has been dispatched
  // across scheduler runs, keyed by preferred name (e.g. "photo.webp" → 2).
  // This matches the key space that makeUniqueOutputFileNames expects.
  const preferredNameCounts = useRef(new Map<string, number>());
  const optimizerRun = useRef<{ runId: string; outputDir: string } | null>(null);
  const tauriDragDropActive = useRef(false);
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

  useEffect(() => {
    return () => {
      window.clearTimeout(debounceRef.current);
    };
  }, []);

  const removeItem = (id: string) => {
    if (!uploads.canMutateQueue()) return;
    setUploadedFocus(null);
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
      const inspection: ImageInspection = await tauriApi.inspectImage({
        path: sourcePath,
        settings: { ...DEFAULT_SETTINGS, quality: qualityRef.current, removeGps: true },
      });

      const sourceFormat = inspection.sourceFormat ?? "unknown";
      const targetFormat = defaultTargetFormat(sourceFormat);
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
    if (!uploads.canMutateQueue()) return;
    setUploadedFocus(null);
    setImporting(true);
    setDropError(null);

    const pendingItems: OptimizeItem[] = paths.map((path) => ({
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

    for (const item of pendingItems) {
      await inspectSingleItem(item.id, item.sourcePath, item.taskVersion ?? 0);
    }

    setImporting(false);
  }, [quality, inspectSingleItem, uploads.canMutateQueue]);

  const handleChooseImages = async () => {
    if (!uploads.canMutateQueue()) return;
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "Images",
          extensions: extensionsFor("compressImport"),
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

    if (!uploads.canMutateQueue()) return;

    // Skip DOM drop when Tauri webview drag/drop is handling it
    if (tauriDragDropActive.current) return;

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
  }, [importImages, uploads.canMutateQueue]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
  }, []);

  useEffect(() => {
    if (!isActive) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    try {
      getCurrentWebview()
        .onDragDropEvent(async (event) => {
          if (disposed) return;
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
          tauriDragDropActive.current = true;
          unlisten = cleanup;
        })
        .catch(() => {});
    } catch {}

    return () => {
      disposed = true;
      tauriDragDropActive.current = false;
      unlisten?.();
    };
  }, [importImages, isActive]);

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
  const applyGlobalRequeue = useCallback((nextQuality: number) => {
    if (!uploads.canMutateQueue()) return false;

    setUploadedFocus(null);
    pendingQualityRef.current = undefined;
    optimizerRun.current = null;
    preferredNameCounts.current.clear();
    uploads.reset();
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
                removeGps: true,
              },
            }
          : item,
      ),
    );
    return true;
  }, [uploads.canMutateQueue, uploads.reset]);

  const scheduleGlobalRequeue = (nextQuality: number) => {
    pendingQualityRef.current = nextQuality;
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      if (!uploads.canMutateQueue()) return;

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
    if (!uploads.canMutateQueue()) return;
    qualityRef.current = nextQuality;
    setQuality(nextQuality);
    scheduleGlobalRequeue(nextQuality);
  };

  // --- Per-item actions ---
  const updateFormat = (id: string, targetFormat: WritableImageFormat) => {
    if (!uploads.canMutateQueue()) return;
    setUploadedFocus(null);
    optimizerRun.current = null;
    preferredNameCounts.current.clear();
    uploads.forgetItem(id);
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
              settings: { ...item.settings, targetFormat, quality, removeGps: true },
            }
          : item,
      ),
    );
  };

  const cancelItem = (id: string) => {
    if (!uploads.canMutateQueue()) return;
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
    if (!uploads.canMutateQueue()) return;
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
                settings: { ...item.settings, quality, removeGps: true },
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

      const copied = await tauriApi.copyOutputsToDir({ outputPaths, targetDir: targetDir as string });
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
    <div className={cn("grid w-full max-w-6xl gap-6", items.length > 0 && "pb-64")}>
      <header className="grid grid-cols-[minmax(0,1fr)_minmax(12rem,25%)] items-end gap-5">
        <div className="min-w-0">
          <h2 className="text-3xl font-semibold tracking-tight text-balance">Compress</h2>
          <p className="text-muted-foreground mt-2 max-w-md text-sm text-pretty">Drop images to compress automatically.</p>
        </div>
        <div className="grid w-full min-w-0 justify-self-end gap-3">
          <span className="text-xs text-muted-foreground text-pretty">
            Metadata (including GPS) is removed during compression
          </span>
          <Label className="grid w-full gap-2 items-start">
            Quality {quality}%
            <Slider aria-label="Quality" value={quality} onValueChange={handleQualityChange} min={1} max={100} disabled={uploads.isUploading} />
          </Label>
        </div>
      </header>

      <button
        type="button"
        data-testid="drop-zone"
        disabled={importing || uploads.isUploading}
        className={cn(
          "w-full border-2 border-dashed rounded-xl bg-muted/40 text-center text-muted-foreground text-sm",
          items.length > 0 ? "flex items-center justify-center gap-3 p-4" : "p-12 px-8",
          "transition-[border-color,background-color] duration-150 ease-out cursor-pointer",
          "hover:border-foreground/30 hover:bg-muted/60",
          "disabled:cursor-not-allowed disabled:opacity-60",
          dragging && "border-primary bg-primary/10 border-solid text-foreground",
        )}
        onClick={handleChooseImages}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className={cn("text-base font-medium text-foreground", items.length === 0 && "mb-2")}>{items.length > 0 ? "Add more images" : "Drop images here"}</div>
        <div className="text-sm text-muted-foreground">
          or{" "}
          <span className="px-1 text-foreground underline underline-offset-4">
            Choose images
          </span>
        </div>
      </button>

      {dropError && (
        <Alert variant="destructive">
          <AlertDescription>{dropError}</AlertDescription>
        </Alert>
      )}
      {importing && (
        <section className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]" aria-label="Importing images">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i}>
              <CardContent className="grid gap-3">
                <Skeleton className="aspect-square w-full" aria-hidden="true" />
                <Skeleton className="h-4 w-4/5" aria-hidden="true" />
                <Skeleton className="h-3 w-2/3" aria-hidden="true" />
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      <section className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]" aria-label="Images to compress">
        {items.map((item) => (
          <OptimizeItemCard
            key={item.id}
            item={item}
            mutationLocked={uploads.isUploading}
            uploadFailure={uploads.failureMessageFor(item.id)}
            uploading={uploads.isItemUploading(item.id)}
            onCancel={cancelItem}
            onCompare={setCompareItemId}
            onFormatChange={updateFormat}
            onRemove={removeItem}
            onRetry={retryItem}
          />
        ))}
      </section>

      {items.length > 0 && (
        <section
          aria-label="Compression actions"
          className="fixed inset-x-0 bottom-0 z-10 max-h-[40dvh] overflow-y-auto border-t bg-background px-10 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-sm max-md:px-6 max-sm:px-4"
        >
        <div className="grid max-w-6xl gap-2">
          <p className="text-sm font-medium tabular-nums" role="status">
            {readyItems.length} of {items.length} ready{failedItemCount > 0 ? ` · ${failedItemCount} failed` : ""}
            {readyItems.length > 0 && ` · Ready total: ${formatBytes(readyOriginalBytes)} → ${formatBytes(readyOutputBytes)} · ${formatBytes(Math.abs(readyOriginalBytes - readyOutputBytes))} ${readyOutputBytes > readyOriginalBytes ? "larger" : "saved"}`}
          </p>
      {saving && <p className="text-sm text-muted-foreground" role="status">Saving files...</p>}
      {uploads.uploadingItemCount > 0 && <p className="text-sm text-muted-foreground" role="status">Uploading {uploads.uploadingItemCount} image(s)...</p>}
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
        <div className="flex flex-wrap items-center gap-2" role="status">
          <p className="text-sm text-muted-foreground">Uploaded {uploadedFocus.highlightedKeys.length} image(s) to {uploadedFocus.destination}. Your local results are still available.</p>
          {onOpenGallery && <Button variant="outline" onClick={onOpenGallery}>View uploaded images</Button>}
        </div>
      )}
      {saveSuccess && <p className="text-sm text-muted-foreground" role="status">{saveSuccess}</p>}

      {items.length > 0 && (
        <p className="text-sm text-muted-foreground break-words" aria-label="Upload destination">
          {uploads.uploadProfile
            ? `Upload destination: ${uploads.uploadProfile.name} · ${uploads.uploadProfile.bucket} / ${uploads.uploadProfile.defaultPrefix || "images"}`
            : "Set an upload destination in Settings. Your compressed images will stay here."}
        </p>
      )}
      {items.some((item) => isCurrentCompressionOutput(item, quality)) && (
        <div className="flex gap-2 flex-wrap">
          <Button type="button" onClick={handleSaveToLocal} disabled={saving || uploads.isUploading}>Save to local folder</Button>
          {uploads.failedUploadCount > 0 && (
            <Button type="button" onClick={uploads.retryUploads} disabled={saving || uploads.isUploading}>
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
        </div>
      )}

        </div>
        </section>
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
