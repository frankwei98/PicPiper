import { useState } from "react";
import type { OptimizeItem } from "../../types";

const DEFAULT_SETTINGS = {
  targetFormat: "webp" as const,
  quality: 68,
  maxWidth: 1600,
  maxHeight: 1600,
  allowUpscale: false,
  removeGps: true,
};

const SAMPLE_ITEMS: OptimizeItem[] = [
  {
    id: "sample-1",
    sourcePath: "/sample/photo-01.jpg",
    fileName: "photo-01.jpg",
    sourceFormat: "jpg",
    originalBytes: 4_200_000,
    estimatedBytes: 720_000,
    status: "pending",
    settings: DEFAULT_SETTINGS,
  },
];

export function OptimizePage() {
  const [items, setItems] = useState<OptimizeItem[]>(SAMPLE_ITEMS);
  const [mode, setMode] = useState<"edit" | "results">("edit");

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

  const handleCompress = () => {
    setMode("results");
  };

  if (mode === "results") {
    const compressedItems = items.map((item) => ({
      ...item,
      status: "compressed" as const,
      outputBytes: item.estimatedBytes ?? item.originalBytes,
      outputFileName: item.fileName.replace(/\.[^.]+$/, `.${item.settings.targetFormat}`),
    }));

    return (
      <div className="page-stack">
        <header className="page-header">
          <div>
            <h2>Compression results</h2>
            <p>Review compressed output before saving.</p>
          </div>
        </header>

        <section className="result-summary" aria-label="Compression results">
          {compressedItems.map((item) => (
            <article className="image-row" key={item.id}>
              <div>
                <strong>{item.outputFileName}</strong>
                <p>
                  {formatBytes(item.originalBytes)} =&gt; {formatBytes(item.outputBytes ?? 0)}
                </p>
              </div>
            </article>
          ))}
        </section>

        <div className="result-actions">
          <button type="button">Save to local folder</button>
          <button type="button">Upload to S3</button>
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
          <button type="button" onClick={handleCompress}>Compress</button>
        </div>
      </header>

      <section className="drop-zone">Drop images here or choose files</section>

      <section className="item-list" aria-label="Images to optimize">
        {items.map((item) => (
          <article className="image-row" key={item.id}>
            <div>
              <strong>{item.fileName}</strong>
              <p>
                {item.sourceFormat.toUpperCase()} -&gt; {item.settings.targetFormat.toUpperCase()} |{" "}
                {formatBytes(item.originalBytes)} =&gt; {formatBytes(item.estimatedBytes ?? 0)}
              </p>
            </div>
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
