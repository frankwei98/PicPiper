import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { CompressionSettings, ImageInspection, OptimizeItem, S3Profile, WritableImageFormat } from "../../types";
import type { GalleryFocus } from "../../state/appState";
import { namingApi, tauriApi, uploadApi } from "../../api/tauri";
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
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { XIcon } from "lucide-react";
import {
  AVAILABLE_OUTPUT_FORMATS,
  defaultTargetFormat,
  formatBytes,
  getCompressionConcurrency,
  makeUniqueOutputFileNames,
  trackDispatchedNames,
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
  const [compareItemId, setCompareItemId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
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
  const qualityRef = useRef(quality);

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
        settings: { ...DEFAULT_SETTINGS, quality: qualityRef.current, removeGps: true },
      });

      const sourceFormat = inspection.sourceFormat ?? "unknown";
      const targetFormat = defaultTargetFormat(sourceFormat);
      const currentQuality = qualityRef.current;
      const currentRemoveGps = true;

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
      settings: { ...DEFAULT_SETTINGS, quality, removeGps: true },
      taskVersion: 0,
    }));

    setItems((current) => [...current, ...pendingItems]);

    for (const item of pendingItems) {
      await inspectSingleItem(item.id, item.sourcePath);
    }

    setImporting(false);
  }, [quality, inspectSingleItem]);

  const handleChooseImages = async () => {
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "Images",
          // HEIF/HEIC intentionally excluded: the built-in optimizer decoder
          // cannot decode them on any platform, so importing them would just
          // surface a confusing "imageDecodeFailed" error. Raw upload via the
          // S3 Gallery still accepts HEIC.
          extensions: ["jpg", "jpeg", "png", "webp", "avif"],
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
  const scheduleGlobalRequeue = (nextQuality: number) => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      optimizerRun.current = null;
      preferredNameCounts.current.clear();
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
    }, 400);
  };

  const handleQualityChange = (nextQuality: number) => {
    qualityRef.current = nextQuality;
    setQuality(nextQuality);
    scheduleGlobalRequeue(nextQuality);
  };

  // --- Per-item actions ---
  const updateFormat = (id: string, targetFormat: WritableImageFormat) => {
    optimizerRun.current = null;
    preferredNameCounts.current.clear();
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

  const executeUploads = async (
    uploadItems: OptimizeItem[],
    prefix: string,
  ): Promise<{ newlyUploaded: string[]; failed: Map<string, string> }> => {
    const itemIds = new Set(uploadItems.map((item) => item.id));
    setUploadingItems(itemIds);
    const newlyUploaded: string[] = [];
    const failed = new Map<string, string>();

    for (const item of uploadItems) {

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
          profile: activeProfile!,
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

      // Remove completed item from uploading set
      itemIds.delete(item.id);
      setUploadingItems(new Set(itemIds));
    }

    setUploadingItems(new Set());
    return { newlyUploaded, failed };
  };

  const uploadToS3 = async () => {
    if (!activeProfile) {
      setUploadError("Configure and select an S3 profile before uploading.");
      return;
    }
    setUploadError(null);
    setUploadFailedItems(new Map());
    const prefix = activeProfile.defaultPrefix || "images";
    const compressedItems = items.filter((item) => item.status === "compressed" && item.outputPath);
    if (compressedItems.length === 0) {
      setUploadError("No compressed outputs to upload.");
      return;
    }

    const { newlyUploaded, failed } = await executeUploads(compressedItems, prefix);
    setUploadFailedItems(failed);

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
    if (!activeProfile) {
      setUploadError("Configure and select an S3 profile before uploading.");
      return;
    }
    setUploadError(null);
    const prefix = activeProfile.defaultPrefix || "images";
    const failedItems = items.filter(
      (item) => item.status === "compressed" && item.outputPath && uploadFailedItems.has(item.id),
    );
    if (failedItems.length === 0) {
      setUploadError("No failed uploads to retry.");
      return;
    }

    const { newlyUploaded, failed: stillFailed } = await executeUploads(failedItems, prefix);
    setUploadFailedItems(stillFailed);

    const allUploadedKeys = [...uploadedKeys, ...newlyUploaded];
    setUploadedKeys(allUploadedKeys);

    if (stillFailed.size === 0) {
      onUploadedToS3?.({
        profileId: activeProfile.id,
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
    <div className="grid max-w-6xl gap-6">
      <header className="flex justify-between items-start gap-6 max-lg:flex-col">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight text-balance">Optimize</h2>
          <p className="text-muted-foreground mt-2 text-sm text-pretty">Drop images to compress automatically.</p>
        </div>
        <div className="flex gap-4 items-end flex-wrap">
          <span className="text-xs text-muted-foreground">
            Metadata (including GPS) is removed during compression
          </span>
          <Label className="grid gap-2 min-w-[220px] items-start">
            Quality {quality}%
            <Slider aria-label="Quality" value={quality} onValueChange={handleQualityChange} min={1} max={100} />
          </Label>
        </div>
      </header>

      <section
        data-testid="drop-zone"
        className={cn(
          "border-2 border-dashed rounded-xl bg-muted/40 p-12 px-8 text-center text-muted-foreground text-sm",
          "transition-[border-color,background-color] duration-150 ease-out cursor-pointer",
          "hover:border-foreground/30 hover:bg-muted/60",
          dragging && "border-primary bg-primary/10 border-solid text-foreground",
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className="text-base font-medium text-foreground mb-2">Drop images here</div>
        <div className="text-sm text-muted-foreground">
          or{" "}
          <Button variant="link" className="h-auto px-1 py-0" type="button" onClick={handleChooseImages} disabled={importing}>
            Choose images
          </Button>
        </div>
      </section>

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

      <section className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]" aria-label="Images to optimize">
        {items.map((item) => (
          <Card className="group relative transition-[transform,box-shadow] hover:-translate-y-px" key={item.id}>
            <CardContent className="grid gap-3">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={`Remove ${item.fileName} from queue`}
                onClick={() => removeItem(item.id)}
              >
                <XIcon className="size-3" />
              </Button>
              <div className="w-full aspect-square rounded-lg overflow-hidden bg-muted flex items-center justify-center">
                {item.status === "compressed" && item.compressedPreviewUrl ? (
                  <Button className="h-full w-full rounded-none p-0" variant="ghost" type="button" aria-label={`Compare ${item.fileName}`} onClick={() => setCompareItemId(item.id)}>
                    <img src={item.compressedPreviewUrl} alt="" loading="lazy" className="w-full h-full object-cover block" />
                  </Button>
                ) : item.originalPreviewUrl ? (
                  <img src={item.originalPreviewUrl} alt="" loading="lazy" className="w-full h-full object-cover block" />
                ) : (
                  <Skeleton className="h-full w-full" aria-hidden="true" />
                )}
              </div>
              <div className="flex flex-col gap-1 min-w-0">
                <strong className="text-sm font-semibold overflow-hidden text-ellipsis whitespace-nowrap">{item.fileName}</strong>
              {item.error ? (
                <p className="text-destructive text-xs mt-0.5">{item.error}</p>
              ) : item.status === "cancelled" ? (
                <p className="text-muted-foreground mt-0.5 text-xs text-pretty">Cancelled</p>
              ) : item.status === "compressing" || item.status === "loadingPreview" ? (
                <p className="text-muted-foreground mt-0.5 text-xs text-pretty tabular-nums">Compressing...</p>
              ) : item.status === "compressed" ? (
                <p className="text-muted-foreground mt-0.5 text-xs text-pretty tabular-nums">
                  {formatBytes(item.originalBytes)} {String.fromCodePoint(0x2192)} {formatBytes(item.outputBytes ?? 0)}{" "}
                  ({savingsPercent(item.originalBytes, item.outputBytes ?? 0)}% saved)
                </p>
              ) : item.originalBytes > 0 ? (
                <p className="text-muted-foreground mt-0.5 text-xs text-pretty tabular-nums">
                  {item.sourceFormat.toUpperCase()} {String.fromCodePoint(0x2192)} {item.settings.targetFormat.toUpperCase()} |{" "}
                  {formatBytes(item.originalBytes)}
                </p>
              ) : null}
              {item.warning && <p className="text-muted-foreground text-xs mt-0.5">{item.warning}</p>}
              {item.settings.targetFormat === "png" && (
                <p className="text-muted-foreground text-xs mt-0.5">Quality does not apply to PNG output.</p>
              )}
              {item.status !== "inspecting" && item.status !== "cancelled" && !item.error && (
                <Label className="flex flex-col items-start gap-2 mt-2 text-xs text-muted-foreground">
                  <NativeSelect
                    aria-label={`Format for ${item.fileName}`}
                    className="w-full"
                    value={item.settings.targetFormat}
                    onChange={(event) => updateFormat(item.id, event.target.value as WritableImageFormat)}
                  >
                    {AVAILABLE_OUTPUT_FORMATS.map((format) => (
                      <NativeSelectOption key={format} value={format}>
                        {format.toUpperCase()}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Label>
              )}
              {uploadFailedItems.has(item.id) && (
                <p className="text-destructive text-xs mt-0.5">{uploadFailedItems.get(item.id)}</p>
              )}
              {uploadingItems.has(item.id) && (
                <p className="text-muted-foreground text-xs mt-0.5">Uploading...</p>
              )}
              {(item.status === "inspecting" || item.status === "queued" || item.status === "compressing" || item.status === "loadingPreview") && (
                <Button variant="ghost" size="sm" type="button" aria-label={`Cancel ${item.fileName}`} onClick={() => cancelItem(item.id)}>Cancel</Button>
              )}
              {(item.status === "failed" || item.status === "cancelled") && (
                <Button variant="ghost" size="sm" type="button" aria-label={`Retry ${item.fileName}`} onClick={() => retryItem(item.id)}>Retry</Button>
              )}
              {(item.status === "compressed" || item.status === "failed" || item.status === "cancelled") && (
                <Button variant="ghost" size="sm" type="button" aria-label={`Remove ${item.fileName}`} onClick={() => removeItem(item.id)}>Remove</Button>
              )}
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      {saving && <p className="text-sm text-muted-foreground" role="status">Saving files...</p>}
      {uploadingItems.size > 0 && <p className="text-sm text-muted-foreground" role="status">Uploading {uploadingItems.size} image(s)...</p>}
      {uploadError && (
        <Alert variant="destructive">
          <AlertDescription>{uploadError}</AlertDescription>
        </Alert>
      )}
      {saveError && (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}
      {saveSuccess && <p className="text-sm text-muted-foreground" role="status">{saveSuccess}</p>}

      {items.some((item) => item.status === "compressed") && (
        <div className="flex gap-2 flex-wrap">
          <Button type="button" onClick={handleSaveToLocal} disabled={saving || uploadingItems.size > 0}>Save to local folder</Button>
          {uploadFailedItems.size > 0 ? (
            <Button type="button" onClick={retryUploads} disabled={saving || uploadingItems.size > 0}>
              Retry {uploadFailedItems.size} failed upload(s)
            </Button>
          ) : (
            <Button type="button" onClick={uploadToS3} disabled={saving || uploadingItems.size > 0}>Upload to S3</Button>
          )}
        </div>
      )}

      {compareItem && (
        <Dialog
          open
          onOpenChange={(open) => { if (!open) setCompareItemId(null); }}
        >
          <DialogContent className="sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>{`Compare ${compareItem.fileName}`}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <p>Quality: {compareItem.settings.quality}</p>
              <p>Metadata: Removed during compression</p>
              <p>Output format: {compareItem.settings.targetFormat}</p>
            </div>
            <div className="grid grid-cols-2 gap-6 max-md:grid-cols-1">
              <div>
                <p className="text-sm font-medium text-muted-foreground mb-2">Original</p>
                {compareItem.originalPreviewUrl && (
                  <img src={compareItem.originalPreviewUrl} alt="" className="w-full rounded-lg border" />
                )}
                <p className="text-xs text-muted-foreground mt-2">{formatBytes(compareItem.originalBytes)}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground mb-2">Compressed</p>
                {compareItem.compressedPreviewUrl && (
                  <img src={compareItem.compressedPreviewUrl} alt="" className="w-full rounded-lg border" />
                )}
                <p className="text-xs text-muted-foreground mt-2">{formatBytes(compareItem.outputBytes ?? 0)}</p>
              </div>
            </div>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
