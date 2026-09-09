import { useEffect, useRef, useState, type UIEvent } from "react";
import { Button } from "@/components/ui/button";
import { tauriApi, type ReadComparisonImageResponse } from "../../api/tauri";
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
  const [mode, setMode] = useState<ComparisonMode>("fit");
  const [images, setImages] = useState<LoadedImages | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const originalPaneRef = useRef<HTMLDivElement>(null);
  const compressedPaneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setImages(null);
    setLoadError(null);

    Promise.all([
      tauriApi.readComparisonImage({ path: originalPath }),
      tauriApi.readComparisonImage({ path: compressedPath }),
    ]).then(
      ([original, compressed]) => {
        if (active) setImages({ original, compressed });
      },
      (error: unknown) => {
        if (active) setLoadError(errorMessage(error, "The image could not be decoded."));
      },
    );

    return () => {
      active = false;
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
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {mode === "fit" ? "Images fitted to each pane" : "100% scale · scroll either image to compare details"}
        </p>
        <div className="flex gap-1" role="group" aria-label="Comparison zoom">
          <Button
            type="button"
            size="sm"
            variant={mode === "fit" ? "secondary" : "ghost"}
            aria-pressed={mode === "fit"}
            onClick={() => setMode("fit")}
          >
            Fit
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
        <div className="grid h-64 place-items-center rounded-lg border bg-muted/30" role="status">
          Loading full-resolution images…
        </div>
      )}

      {loadError && (
        <div className="grid h-64 place-items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center" role="alert">
          <div>
            <p className="font-medium">Could not load the comparison</p>
            <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => setLoadAttempt((value) => value + 1)}>
            Try again
          </Button>
        </div>
      )}

      {images && (
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
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
  label: string;
  image: ReadComparisonImageResponse;
  mode: ComparisonMode;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
}

function ComparisonPane({ ref, label, image, mode, onScroll }: ComparisonPaneProps) {
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-2 text-sm">
        <p className="font-medium text-muted-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{image.width} × {image.height} px</p>
      </div>
      <div
        ref={ref}
        tabIndex={mode === "actual" ? 0 : undefined}
        role="region"
        aria-label={`${label} image pane`}
        data-testid={`${label.toLowerCase()}-comparison-pane`}
        className={cn(
          "h-[40dvh] min-h-32 rounded-lg border focus-visible:outline-2 focus-visible:outline-ring overscroll-contain bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)_50%/16px_16px]",
          mode === "actual" ? "overflow-auto" : "grid place-items-center overflow-hidden",
        )}
        onScroll={onScroll}
      >
        <img
          src={image.dataUrl}
          alt={`${label} full-resolution preview`}
          width={image.width}
          height={image.height}
          draggable={false}
          className={cn(
            "block select-none",
            mode === "fit" ? "max-h-full max-w-full object-contain" : "max-w-none",
          )}
          style={mode === "actual" ? { width: image.width, height: image.height } : undefined}
        />
      </div>
    </section>
  );
}
