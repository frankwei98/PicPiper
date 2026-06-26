import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { CompressionSettings, OptimizeItem, S3Profile } from "../../types";
import { namingApi, tauriApi, uploadApi } from "../../api/tauri";
import { cn } from "../../utils/cn";
import { Slider } from "../../components/ui/Slider";

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
  const [mode, setMode] = useState<"edit" | "results">("edit");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const thumbnailQueue = useRef<Array<{ id: string; path: string }>>([]);
  const activeThumbnails = useRef(0);
  const maxConcurrentThumbnails = 3;

  const canCompress = items.some((item) => item.status === "ready" || item.status === "pending");

  const removeItem = (id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
    setThumbnails((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const loadThumbnail = useCallback(async (id: string, path: string) => {
    try {
      const res = await tauriApi.readThumbnail({ path, maxSize: 256 });
      setThumbnails((current) => ({ ...current, [id]: res.dataUrl }));
    } catch {
      // Thumbnails are best-effort; failures leave the placeholder.
    } finally {
      activeThumbnails.current -= 1;
      drainThumbnailQueue();
    }
  }, []);

  const drainThumbnailQueue = useCallback(() => {
    while (activeThumbnails.current < maxConcurrentThumbnails && thumbnailQueue.current.length > 0) {
      const next = thumbnailQueue.current.shift()!;
      activeThumbnails.current += 1;
      void loadThumbnail(next.id, next.path);
    }
  }, [loadThumbnail]);

  const enqueueThumbnail = useCallback((id: string, path: string) => {
    thumbnailQueue.current.push({ id, path });
    drainThumbnailQueue();
  }, [drainThumbnailQueue]);

  const updateQuality = (id: string, quality: number) => {
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              estimatedBytes: Math.round(item.originalBytes * (quality / 100) * 0.25),
              settings: { ...item.settings, quality },
            }
          : item,
      ),
    );
  };

  const handleApplyDefaults = () => {
    setItems((current) =>
      current.map((item) => ({
        ...item,
        estimatedBytes: Math.round(item.originalBytes * (DEFAULT_SETTINGS.quality / 100) * 0.25),
        settings: { ...DEFAULT_SETTINGS },
      })),
    );
  };

  const importImages = useCallback(async (paths: string[]) => {
    setImporting(true);
    setDropError(null);

    const results = await Promise.allSettled(
      paths.map((path) =>
        tauriApi.inspectImage({ path, settings: DEFAULT_SETTINGS }),
      ),
    );

    const newItems: OptimizeItem[] = results.map((result, index) => {
      if (result.status === "fulfilled") {
        const raw = result.value as unknown as Record<string, unknown>;
        const settings = (raw.settings as CompressionSettings) ?? DEFAULT_SETTINGS;
        return {
          id: (raw.id as string) ?? crypto.randomUUID(),
          sourcePath: (raw.sourcePath as string) ?? (raw.path as string) ?? paths[index],
          fileName: (raw.fileName as string) ?? (raw.file_name as string) ?? paths[index].split("/").pop() ?? "unknown",
          sourceFormat: (raw.sourceFormat as OptimizeItem["sourceFormat"]) ?? (raw.source_format as OptimizeItem["sourceFormat"]) ?? "unknown",
          originalBytes: (raw.originalBytes as number) ?? (raw.original_bytes as number) ?? 0,
          estimatedBytes: (raw.estimatedBytes as number) ?? (raw.estimated_bytes as number) ?? 0,
          status: (raw.status as OptimizeItem["status"]) ?? "ready",
          warning: raw.warning as string | undefined,
          settings,
        };
      }
      return {
        id: crypto.randomUUID(),
        sourcePath: paths[index],
        fileName: paths[index].split("/").pop() ?? "unknown",
        sourceFormat: "unknown" as const,
        originalBytes: 0,
        status: "failed" as const,
        error: result.reason instanceof Error ? result.reason.message : "Inspection failed",
        settings: { ...DEFAULT_SETTINGS },
      };
    });

    setItems((current) => [...current, ...newItems]);
    setImporting(false);

    for (const item of newItems) {
      if (item.status !== "failed" && item.sourcePath) {
        enqueueThumbnail(item.id, item.sourcePath);
      }
    }
  }, [enqueueThumbnail]);

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

  const [compressError, setCompressError] = useState<string | null>(null);

  const handleCompress = async () => {
    setCompressError(null);
    setCompressing(true);

    const batchItems = items
      .filter((item) => item.status === "ready" || item.status === "pending")
      .map((item) => ({
        id: item.id,
        sourcePath: item.sourcePath,
        outputFileName: item.fileName.replace(/\.[^.]+$/, `.${item.settings.targetFormat}`),
        settings: item.settings,
      }));

    setItems((current) =>
      current.map((item) =>
        item.status === "ready" || item.status === "pending"
          ? { ...item, status: "compressing" as const }
          : item,
      ),
    );

    try {

      const response = await tauriApi.compressBatch({ items: batchItems });

      setItems((current) =>
        current.map((item) => {
          const batchResult = response.items.find((r) => r.id === item.id);
          if (!batchResult) return item;
          if (batchResult.error) {
            return { ...item, status: "failed" as const, error: batchResult.error.message };
          }
          if (batchResult.result) {
            return {
              ...item,
              status: "compressed" as const,
              outputBytes: batchResult.result.outputBytes,
              outputPath: batchResult.result.outputPath,
              outputFileName: batchResult.result.outputFileName,
            };
          }
          return item;
        }),
      );

      setMode("results");
    } catch (err) {
      setCompressError(err instanceof Error ? err.message : "Compression failed");
      setItems((current) =>
        current.map((item) =>
          item.status === "compressing"
            ? { ...item, status: "ready" as const }
            : item,
        ),
      );
    } finally {
      setCompressing(false);
    }
  };

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

  if (mode === "results") {
    return (
      <div className="grid gap-lg max-w-page">
        <header className="flex justify-between items-start gap-lg">
          <div>
            <h2 className="text-large-title font-bold text-on-surface text-balance">Compression results</h2>
            <p className="text-on-surface-variant mt-xs text-body text-pretty">Review compressed output before saving.</p>
          </div>
        </header>

        <section className="bg-surface-container border border-outline-variant rounded-md p-lg" aria-label="Compression results">
          {items.map((item) => (
            <article className="relative bg-surface-container border border-outline-variant rounded-md flex flex-col gap-sm p-md transition-[border-color,background-color] duration-150 ease-out hover:border-outline hover:bg-surface-container-high" key={item.id}>
              <div>
                <strong className="text-callout font-semibold text-on-surface truncate">{item.outputFileName ?? item.fileName.replace(/\.[^.]+$/, `.${item.settings.targetFormat}`)}</strong>
                {item.error ? (
                  <p className="text-error text-caption mt-0.5">{item.error}</p>
                ) : (
                  <p className="text-on-surface-variant mt-0.5 text-footnote tabular-nums">
                    {formatBytes(item.originalBytes)} → {formatBytes(item.outputBytes ?? item.estimatedBytes ?? 0)}
                  </p>
                )}
                {uploadingItems.has(item.id) && <p className="text-on-surface-variant text-caption mt-0.5">Uploading...</p>}
                {uploadFailedItems.has(item.id) && (
                  <p className="text-error text-caption mt-0.5">{uploadFailedItems.get(item.id)}</p>
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

        <div className="flex gap-sm flex-wrap">
          <button className={btnPrimary} type="button" onClick={handleSaveToLocal} disabled={saving || uploadingItems.size > 0}>Save to local folder</button>
          <button className={btnPrimary} type="button" onClick={uploadToS3} disabled={saving || uploadingItems.size > 0}>Upload to S3</button>
          <button className={btnSecondary} type="button" onClick={() => setMode("edit")}>Back to edit settings</button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-lg max-w-page">
      <header className="flex justify-between items-start gap-lg">
        <div>
          <h2 className="text-large-title font-bold text-on-surface text-balance">Optimize</h2>
          <p className="text-on-surface-variant mt-xs text-body text-pretty">Tune each image, then compress.</p>
        </div>
        <div className="flex gap-sm items-end flex-wrap">
          <button className={btnSecondary} type="button" onClick={handleApplyDefaults}>Reset to defaults</button>
          <button className={btnPrimary} type="button" disabled={!canCompress} onClick={handleCompress}>Compress</button>
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
      {compressing && <p className="text-on-surface-variant text-footnote">Compressing images...</p>}
      {compressError && <p className="text-error text-footnote">{compressError}</p>}

      <section className="grid gap-sm grid-cols-[repeat(auto-fill,minmax(220px,1fr))]" aria-label="Images to optimize">
        {items.map((item) => (
          <article className="relative bg-surface-container border border-outline-variant rounded-md flex flex-col gap-sm p-md transition-[border-color,background-color] duration-150 ease-out hover:border-outline hover:bg-surface-container-high" key={item.id}>
            <button
              type="button"
              className="absolute top-1 right-1 size-[22px] border-none rounded-full bg-surface-container-high text-on-surface-variant text-base leading-none p-0 cursor-pointer flex items-center justify-center opacity-0 transition-[opacity,background] duration-150 group-hover:opacity-100 focus-within:opacity-100 hover:bg-outline hover:text-on-surface"
              aria-label={`Remove ${item.fileName} from queue`}
              onClick={() => removeItem(item.id)}
            >
              ×
            </button>
            <div className="w-full aspect-square rounded-[calc(var(--radius-md)-2px)] overflow-hidden bg-surface-container-low flex items-center justify-center">
              {thumbnails[item.id] ? (
                <img src={thumbnails[item.id]} alt="" loading="lazy" className="w-full h-full object-cover block" />
              ) : (
                <span className="w-full h-full bg-surface-container-high" aria-hidden="true" />
              )}
            </div>
            <div className="flex flex-col gap-0.5 min-w-0">
              <strong className="text-callout font-semibold text-on-surface overflow-hidden text-ellipsis whitespace-nowrap">{item.fileName}</strong>
              {item.error ? (
                <p className="text-error text-caption mt-0.5">{item.error}</p>
              ) : (
                <p className="text-on-surface-variant mt-0.5 text-footnote text-pretty tabular-nums">
                  {item.sourceFormat.toUpperCase()} → {item.settings.targetFormat.toUpperCase()} |{" "}
                  {formatBytes(item.originalBytes)} → {formatBytes(item.estimatedBytes ?? 0)}
                </p>
              )}
              {item.warning && <p className="text-on-tertiary text-caption mt-0.5">{item.warning}</p>}
              {!item.error && (
                <label className="flex flex-col mt-xs text-footnote text-on-surface-variant">
                  Quality {item.settings.quality}%
                  <Slider
                    value={item.settings.quality}
                    onValueChange={(v) => updateQuality(item.id, v)}
                    min={1}
                    max={100}
                  />
                </label>
              )}
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}
