import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { CompressionSettings, ImageFormat, OptimizeItem, S3Profile } from "../../types";
import { namingApi, tauriApi, uploadApi } from "../../api/tauri";
import { cn } from "../../utils/cn";
import { Slider } from "../../components/ui/Slider";
import { Dialog } from "../../components/ui/Dialog";
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
  onUploadedToS3?: (focus: {
    profile: S3Profile;
    prefix: string;
    highlightedKeys: string[];
  }) => void;
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

const btnBase = "border-none rounded-md cursor-pointer text-callout font-medium px-5 py-2.5 transition-[background-color,box-shadow,filter] duration-150 ease-out inline-flex items-center justify-center gap-sm leading-none focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-38 disabled:cursor-not-allowed disabled:pointer-events-none";
const btnPrimary = cn(btnBase, "bg-primary-container text-on-primary-container font-semibold hover:shadow-[0_1px_3px_rgba(0,0,0,0.3)] hover:brightness-110");
const btnSecondary = cn(btnBase, "bg-white/5 border border-outline-variant text-on-surface hover:bg-white/10 hover:border-outline");
const btnTertiary = cn(btnBase, "bg-transparent text-primary px-3 hover:bg-[rgba(255,189,127,0.1)]");

export function OptimizePage({ activeProfile, namingTemplate, onUploadedToS3 }: OptimizePageProps) {
  const [items, setItems] = useState<OptimizeItem[]>([]);
  const [quality, setQuality] = useState(DEFAULT_SETTINGS.quality);
  const [removeGps, setRemoveGps] = useState(DEFAULT_SETTINGS.removeGps);
  const [compareItemId, setCompareItemId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const activeTasks = useRef(new Set<string>());
  const optimizerRun = useRef<{ runId: string; outputDir: string } | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      window.clearTimeout(debounceRef.current);
    };
  }, []);

  const removeItem = (id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  };

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
      try {
        const raw = (await tauriApi.inspectImage({
          path: item.sourcePath,
          settings: { ...DEFAULT_SETTINGS, quality, removeGps },
        })) as unknown as Record<string, unknown>;

        const fileName = (raw.fileName as string) ?? (raw.file_name as string) ?? item.sourcePath.split("/").pop() ?? "unknown";
        const sourceFormat = (raw.sourceFormat as OptimizeItem["sourceFormat"]) ?? (raw.source_format as OptimizeItem["sourceFormat"]) ?? "unknown";
        const originalBytes = (raw.originalBytes as number) ?? (raw.original_bytes as number) ?? 0;
        const estimatedBytes = (raw.estimatedBytes as number) ?? (raw.estimated_bytes as number) ?? 0;
        const targetFormat = defaultTargetFormat(sourceFormat);

        item.fileName = fileName;
        item.sourceFormat = sourceFormat;
        item.originalBytes = originalBytes;
        item.estimatedBytes = estimatedBytes;
        item.warning = raw.warning as string | undefined;
        item.status = "queued";
        item.settings = { targetFormat, quality, removeGps };

        setItems((current) =>
          current.map((ci) => (ci.id === item.id ? { ...item } : ci)),
        );

        try {
          const thumb = await tauriApi.readThumbnail({ path: item.sourcePath, maxSize: 512 });
          item.originalPreviewUrl = thumb.dataUrl;
          setItems((current) =>
            current.map((ci) => (ci.id === item.id ? { ...item } : ci)),
          );
        } catch {
          // Thumbnails are best-effort
        }
      } catch (err) {
        item.status = "failed";
        item.error = err instanceof Error ? err.message : "Inspection failed";
        setItems((current) =>
          current.map((ci) => (ci.id === item.id ? { ...item } : ci)),
        );
      }
    }

    setImporting(false);
  }, [quality, removeGps]);

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

    const outputNames = makeUniqueOutputFileNames(
      items
        .filter((item) => item.status === "queued")
        .map((item) => ({
          id: item.id,
          fileName: item.fileName,
          targetFormat: item.settings.targetFormat,
        })),
    );

    const nextItems = items.filter((item) => item.status === "queued").slice(0, availableSlots);
    for (const item of nextItems) {
      activeTasks.current.add(item.id);
      void runCompressionTask(item, outputNames[item.id]);
    }
  }, [items, quality, removeGps, runCompressionTask]);

  // --- Global settings requeue with debounce ---
  const scheduleGlobalRequeue = (nextQuality: number, nextRemoveGps: boolean) => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
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
    setQuality(nextQuality);
    scheduleGlobalRequeue(nextQuality, removeGps);
  };

  const handleRemoveGpsChange = (checked: boolean) => {
    setRemoveGps(checked);
    scheduleGlobalRequeue(quality, checked);
  };

  // --- Per-item actions ---
  const updateFormat = (id: string, targetFormat: ImageFormat) => {
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
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              status: item.originalBytes > 0 ? "queued" : "inspecting",
              error: undefined,
              cancelling: false,
              taskVersion: (item.taskVersion ?? 0) + 1,
              settings: { ...item.settings, quality, removeGps },
            }
          : item,
      ),
    );
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

    setUploadingItems(new Set(compressedItems.map((item) => item.id)));

    const uploaded: { key: string }[] = [];
    const failed = new Map<string, string>();

    for (const item of compressedItems) {
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

        uploaded.push(result);
      } catch (err) {
        failed.set(item.id, err instanceof Error ? err.message : "Upload failed");
      }
    }

    setUploadingItems(new Set());
    setUploadFailedItems(failed);

    if (failed.size === 0) {
      onUploadedToS3?.({
        profile: activeProfile,
        prefix,
        highlightedKeys: uploaded.map((object) => object.key),
      });
    } else {
      setUploadError(
        `${failed.size} of ${compressedItems.length} upload(s) failed. Fix and retry.`,
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
          <label className="flex items-center gap-sm text-footnote font-medium text-on-surface-variant">
            <input type="checkbox" checked={removeGps} onChange={(e) => handleRemoveGpsChange(e.target.checked)} />
            Remove GPS
          </label>
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
              {item.status !== "inspecting" && item.status !== "cancelled" && !item.error && (
                <label className="flex flex-col mt-xs text-footnote text-on-surface-variant">
                  <select
                    aria-label={`Format for ${item.fileName}`}
                    value={item.settings.targetFormat}
                    onChange={(event) => updateFormat(item.id, event.target.value as ImageFormat)}
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
                <button className={btnTertiary} type="button" onClick={() => cancelItem(item.id)}>Cancel</button>
              )}
              {(item.status === "failed" || item.status === "cancelled") && (
                <button className={btnTertiary} type="button" onClick={() => retryItem(item.id)}>Retry</button>
              )}
              {(item.status === "compressed" || item.status === "failed" || item.status === "cancelled") && (
                <button className={btnTertiary} type="button" onClick={() => removeItem(item.id)}>Remove</button>
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
          <button className={btnPrimary} type="button" onClick={uploadToS3} disabled={saving || uploadingItems.size > 0}>Upload to S3</button>
        </div>
      )}

      {compareItem && (
        <Dialog
          open
          onOpenChange={(open) => { if (!open) setCompareItemId(null); }}
          title={`Compare ${compareItem.fileName}`}
        >
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
