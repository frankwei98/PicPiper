import { t, useLocale } from "@/i18n";
import { useEffect, useRef, useState, type UIEvent } from "react";
import { Button } from "@/components/ui/button";
import { imageApi, type ReadComparisonImageResponse } from "../../api/backend";
import { errorMessage } from "../../lib/error";
import { cn } from "@/lib/utils";

type ComparisonMode = "fit" | "actual";

export interface ImageComparisonProps {
  originalPath: string;
  compressedPath: string;
}

interface LoadedImages {
  original: ReadComparisonImageResponse;
  compressed: ReadComparisonImageResponse;
}

export function ImageComparison({ originalPath, compressedPath }: ImageComparisonProps) {
  useLocale();
  const [mode, setMode] = useState<ComparisonMode>("fit");
  const [images, setImages] = useState<LoadedImages | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const originalPaneRef = useRef<HTMLDivElement>(null);
  const compressedPaneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let cancelled = false;
    const taskId = `comparison:${crypto.randomUUID()}`;
    const cancelReads = () => {
      if (cancelled) return;
      cancelled = true;
      void imageApi.cancelImageTask({ taskId }).catch(() => {
        // Closing the app may also close the bridge; ignore late results below.
      });
    };
    setImages(null);
    setLoadError(null);

    Promise.all([
      imageApi.readComparisonImage({ taskId, path: originalPath }),
      imageApi.readComparisonImage({ taskId, path: compressedPath }),
    ]).then(
      ([original, compressed]) => {
        if (active) setImages({ original, compressed });
      },
      (error: unknown) => {
        cancelReads();
        if (active) setLoadError(errorMessage(error, t("The image could not be decoded.")));
      },
    );

    return () => {
      active = false;
      cancelReads();
    };
  }, [compressedPath, loadAttempt, originalPath]);

  useEffect(() => {
    originalPaneRef.current?.scrollTo({ left: 0, top: 0 });
    compressedPaneRef.current?.scrollTo({ left: 0, top: 0 });
  }, [mode]);

  const syncScroll = (event: UIEvent<HTMLDivElement>, target: HTMLDivElement | null) => {
    if (!target) return;
    target.scrollLeft = event.currentTarget.scrollLeft;
    target.scrollTop = event.currentTarget.scrollTop;
  };

  return (
    <div className="compare-root">
      <div className="compare-toolbar">
        <p>
          {mode === "fit" ? t("Images fitted to each pane") : t("100% scale. Scroll either image to compare details.")}
        </p>
        <div className="compare-zooms" role="group" aria-label={t("Comparison zoom")}>
          <Button
            type="button"
            size="sm"
            variant={mode === "fit" ? "secondary" : "ghost"}
            aria-pressed={mode === "fit"}
            onClick={() => setMode("fit")}
          >
            {t("Fit")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "actual" ? "secondary" : "ghost"}
            aria-pressed={mode === "actual"}
            onClick={() => setMode("actual")}
          >
            100%
          </Button>
        </div>
      </div>

      {!images && !loadError && (
        <div className="compare-state" role="status">
          {t("Loading full-resolution images…")}
        </div>
      )}

      {loadError && (
        <div className="compare-state danger" role="alert">
          <div>
            <strong>{t("Could not load the comparison")}</strong>
            <p>{loadError}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => setLoadAttempt((value) => value + 1)}>
              {t("Try again")}
            </Button>
          </div>
        </div>
      )}

      {images && (
        <div className="compare-grid">
          <ComparisonPane
            ref={originalPaneRef}
            label="Original"
            image={images.original}
            mode={mode}
            onScroll={(event) => syncScroll(event, compressedPaneRef.current)}
          />
          <ComparisonPane
            ref={compressedPaneRef}
            label="Compressed"
            image={images.compressed}
            mode={mode}
            onScroll={(event) => syncScroll(event, originalPaneRef.current)}
          />
        </div>
      )}
    </div>
  );
}

interface ComparisonPaneProps {
  ref: React.Ref<HTMLDivElement>;
  label: "Original" | "Compressed";
  image: ReadComparisonImageResponse;
  mode: ComparisonMode;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
}

function ComparisonPane({ ref, label, image, mode, onScroll }: ComparisonPaneProps) {
  return (
    <section className="min-w-0">
      <div className="compare-pane-head">
        <strong>{t(label)}</strong>
        <span className="numeric">{image.width} × {image.height} {t("px")}</span>
      </div>
      <div
        ref={ref}
        tabIndex={mode === "actual" ? 0 : undefined}
        role="region"
        aria-label={t("{{label}} image pane", { label: t(label) })}
        data-testid={`${label.toLowerCase()}-comparison-pane`}
        className={cn("compare-pane", mode === "actual" ? "scrollable" : "grid place-items-center")}
        onScroll={onScroll}
      >
        <img
          src={image.dataUrl}
          alt={t("{{label}} full-resolution preview", { label: t(label) })}
          width={image.width}
          height={image.height}
          draggable={false}
          className={cn("block select-none", mode === "fit" ? "max-h-full max-w-full object-contain" : "max-w-none")}
          style={mode === "actual" ? { width: image.width, height: image.height } : undefined}
        />
      </div>
    </section>
  );
}
