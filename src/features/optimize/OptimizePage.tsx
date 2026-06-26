import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { CompressionSettings, OptimizeItem, S3Profile } from "../../types";
import { namingApi, tauriApi, uploadApi } from "../../api/tauri";

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

export function OptimizePage({ activeProfile, namingTemplate, onUploadedToS3 }: OptimizePageProps) {
  const [items, setItems] = useState<OptimizeItem[]>([]);
  const [mode, setMode] = useState<"edit" | "results">("edit");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [saving, setSaving] = useState(false);

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
    setImporting(true);

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
  };

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

  const handleSaveToLocal = async () => {
    setSaveError(null);
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
      alert(`Saved ${copied.length} file(s) to ${targetDir}`);
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
          sourcePath: item.sourcePath,
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
                {uploadingItems.has(item.id) && <p className="item-status">Uploading...</p>}
                {uploadFailedItems.has(item.id) && (
                  <p className="item-error">{uploadFailedItems.get(item.id)}</p>
                )}
              </div>
            </article>
          ))}
        </section>

        {saving && <p className="status-line">Saving files...</p>}
        {uploadingItems.size > 0 && <p className="status-line">Uploading {uploadingItems.size} image(s)...</p>}
        {uploadError && <p className="error-text">{uploadError}</p>}
        {saveError && <p className="error-text">{saveError}</p>}

        <div className="result-actions">
          <button type="button" onClick={handleSaveToLocal} disabled={saving || uploadingItems.size > 0}>Save to local folder</button>
          <button type="button" onClick={uploadToS3} disabled={saving || uploadingItems.size > 0}>Upload to S3</button>
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
        <button type="button" onClick={handleChooseImages} disabled={importing}>
          Choose images
        </button>
      </section>

      {importing && <p className="status-line">Importing images...</p>}
      {compressing && <p className="status-line">Compressing images...</p>}
      {compressError && <p className="error-text">{compressError}</p>}

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
