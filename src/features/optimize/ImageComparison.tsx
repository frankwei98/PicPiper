import { ImageWithSkeleton } from "@/components/ImageWithSkeleton";
import { Skeleton } from "@/components/ui/skeleton";
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
  const pendingScrolls = useRef(new Map<HTMLDivElement, { left: number; top: number }>());

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
    pendingScrolls.current.clear();
  }, [mode, images]);

  useEffect(() => {
    originalPaneRef.current?.scrollTo({ left: 0, top: 0 });
    compressedPaneRef.current?.scrollTo({ left: 0, top: 0 });
  }, [mode]);

  const syncScroll = (event: UIEvent<HTMLDivElement>, target: HTMLDivElement | null) => {
    const source = event.currentTarget;
    const pending = pendingScrolls.current.get(source);
    pendingScrolls.current.delete(source);
    if (pending && source.scrollLeft === pending.left && source.scrollTop === pending.top) return;
    if (!target) return;
    target.scrollLeft = source.scrollLeft;
    target.scrollTop = source.scrollTop;
    // Smaller outputs can clamp these offsets. Suppress only the resulting
    // position so a user scroll on either pane can still drive synchronization.
    pendingScrolls.current.set(target, { left: target.scrollLeft, top: target.scrollTop });
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
        <div role="status" aria-label={t("Loading full-resolution images…")} aria-busy="true">
          <span className="sr-only">{t("Loading full-resolution images…")}</span>
          <div className="compare-grid" aria-hidden="true">{[0, 1].map((index) => <section key={index}>
            <Skeleton className="h-4 w-24 mb-2" />
            <Skeleton className="compare-pane" />
          </section>)}</div>
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
        <ImageWithSkeleton
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
