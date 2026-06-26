import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { CompressionSettings, OptimizeItem, S3Profile } from "../../types";
import { tauriApi, uploadApi } from "../../api/tauri";

const DEFAULT_SETTINGS: CompressionSettings = {
  targetFormat: "webp",
  quality: 68,
  maxWidth: 1600,
  maxHeight: 1600,
  allowUpscale: false,
  removeGps: true,
};

interface OptimizePageProps {
  onUploadedToS3?: (focus: {
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

export function OptimizePage({ activeProfile, onUploadedToS3 }: OptimizePageProps) {
  const [items, setItems] = useState<OptimizeItem[]>([]);
  const [mode, setMode] = useState<"edit" | "results">("edit");
  const [uploadError, setUploadError] = useState<string | null>(null);

  const canCompress = items.some((item) => item.status === "ready" || item.status === "pending");

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
  };

  const [compressError, setCompressError] = useState<string | null>(null);

  const handleCompress = async () => {
    setCompressError(null);
    setItems((current) =>
      current.map((item) =>
        item.status === "ready" || item.status === "pending"
          ? { ...item, status: "compressing" as const }
          : item,
      ),
    );

    try {
      const batchItems = items
        .filter((item) => item.status === "compressing")
        .map((item) => ({
          id: item.id,
          sourcePath: item.sourcePath,
          outputFileName: item.fileName.replace(/\.[^.]+$/, `.${item.settings.targetFormat}`),
          settings: item.settings,
        }));

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
    }
  };

  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSaveToLocal = async () => {
    setSaveError(null);
    try {
      const targetDir = await open({ directory: true });
      if (!targetDir) return;

      const outputPaths = items
        .filter((item) => item.status === "compressed" && item.outputPath)
        .map((item) => item.outputPath as string);

      if (outputPaths.length === 0) {
        setSaveError("No compressed outputs to save.");
        return;
      }

      const copied = await tauriApi.copyOutputsToDir({ outputPaths, targetDir: targetDir as string });
      alert(`Saved ${copied.length} file(s) to ${targetDir}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save files");
    }
  };

  const uploadToS3 = async () => {
    if (!activeProfile) {
      setUploadError("Configure and select an S3 profile before uploading.");
      return;
    }
    setUploadError(null);
    const prefix = activeProfile.defaultPrefix || "images";
    const compressedItems = items.filter((item) => item.status === "compressed" && item.outputPath);
    const uploaded = await Promise.all(
      compressedItems.map((item) => {
        const outputFileName = item.outputFileName ?? "image.webp";
        const objectKey = `${prefix.replace(/\/$/, "")}/${outputFileName}`;
        return uploadApi.uploadObject({
          profile: activeProfile,
          sourcePath: item.outputPath as string,
          objectKey,
          contentType: contentTypeFor(item.settings.targetFormat),
        });
      }),
    );
    onUploadedToS3?.({
      prefix,
      highlightedKeys: uploaded.map((object) => object.key),
    });
  };

  if (mode === "results") {
    return (
      <div className="page-stack">
        <header className="page-header">
          <div>
            <h2>Compression results</h2>
            <p>Review compressed output before saving.</p>
          </div>
        </header>

        <section className="result-summary" aria-label="Compression results">
          {items.map((item) => (
            <article className="image-row" key={item.id}>
              <div>
                <strong>{item.outputFileName ?? item.fileName.replace(/\.[^.]+$/, `.${item.settings.targetFormat}`)}</strong>
                {item.error ? (
                  <p className="item-error">{item.error}</p>
                ) : (
                  <p>
                    {formatBytes(item.originalBytes)} =&gt; {formatBytes(item.outputBytes ?? item.estimatedBytes ?? 0)}
                  </p>
                )}
              </div>
            </article>
          ))}
        </section>

        {uploadError && <p className="upload-error">{uploadError}</p>}
        {saveError && <p className="upload-error">{saveError}</p>}

        <div className="result-actions">
          <button type="button" onClick={handleSaveToLocal}>Save to local folder</button>
          <button type="button" onClick={uploadToS3}>Upload to S3</button>
          <button type="button" onClick={() => setMode("edit")}>Back to edit settings</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h2>Optimize</h2>
          <p>Apply a preset, tune each image, then compress.</p>
        </div>
        <div className="header-actions">
          <button type="button">Apply preset</button>
          <button type="button" disabled={!canCompress} onClick={handleCompress}>Compress</button>
        </div>
      </header>

      <section className="drop-zone">
        Drop images here or{" "}
        <button type="button" onClick={handleChooseImages}>
          Choose images
        </button>
      </section>

      {compressError && <p className="upload-error">{compressError}</p>}

      <section className="item-list" aria-label="Images to optimize">
        {items.map((item) => (
          <article className="image-row" key={item.id}>
            <div>
              <strong>{item.fileName}</strong>
              {item.error ? (
                <p className="item-error">{item.error}</p>
              ) : (
                <p>
                  {item.sourceFormat.toUpperCase()} -&gt; {item.settings.targetFormat.toUpperCase()} |{" "}
                  {formatBytes(item.originalBytes)} =&gt; {formatBytes(item.estimatedBytes ?? 0)}
                </p>
              )}
              {item.warning && <p className="item-warning">{item.warning}</p>}
            </div>
            {!item.error && (
              <label>
                Quality {item.settings.quality}%
                <input
                  max={100}
                  min={1}
                  onChange={(event) => updateQuality(item.id, Number(event.currentTarget.value))}
                  type="range"
                  value={item.settings.quality}
                />
              </label>
            )}
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
