import { LazyRender } from "@/components/LazyRender";
import { ImageWithSkeleton } from "@/components/ImageWithSkeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { OptimizeItemSkeleton } from "./OptimizeItemSkeleton";
import { t, useLocale, imageCount } from "@/i18n";
import { useEffect, useState } from "react";
import { Expand, Image as ImageIcon, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { OptimizeItem, WritableImageFormat } from "../../types";
import { AVAILABLE_OUTPUT_FORMATS, formatBytes, sizeChangeLabel } from "./optimizeQueue";
import { OptimizeItemCard } from "./OptimizeItemCard";
import { STAGE_PREVIEW_EDGE, useOptimizePreview, type OptimizePreviews } from "./optimizePreviews";

export type CompressionPreset = "original" | "balanced" | "small" | "lossless" | "custom";

interface OptimizeWorkspaceProps {
  items: OptimizeItem[];
  previews: OptimizePreviews;
  active: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  quality: number;
  batchFormat: WritableImageFormat | "original";
  onBatchFormat: (format: WritableImageFormat | "original") => void;
  maxDimension: number;
  onMaxDimension: (value: number) => void;
  preset: CompressionPreset;
  onPreset: (preset: Exclude<CompressionPreset, "custom">) => void;
  onQuality: (quality: number) => void;
  locked: boolean;
  onClear: () => void;
  onCancel: (id: string) => void;
  onCompare: (id: string) => void;
  onFormat: (id: string, format: WritableImageFormat) => void;
  onAnimationMode: (id: string, mode: "preserve" | "firstFrame") => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  uploadFailure: (id: string) => string | undefined;
  isUploading: (id: string) => boolean;
  onChooseImages: () => void;
  chooseDisabled: boolean;
  dragging: boolean;
  onDrop: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: (event: React.DragEvent) => void;
}

export function OptimizeWorkspace(props: OptimizeWorkspaceProps) {
  useLocale();
  const [preview, setPreview] = useState<"original" | "compressed">("compressed");
  const [qualityDraft, setQualityDraft] = useState(String(props.quality));
  useEffect(() => setQualityDraft(String(props.quality)), [props.quality]);
  const qualityNotApplicable = props.items.length > 0 ? props.items.every((item) => item.settings.targetFormat === "png") : props.batchFormat === "png";
  const commitQuality = (draft = qualityDraft) => {
    const parsed = Number(draft);
    const quality = draft.trim() && Number.isFinite(parsed) ? Math.max(1, Math.min(100, Math.round(parsed))) : props.quality;
    setQualityDraft(String(quality));
    if (quality !== props.quality) props.onQuality(quality);
  };
  const sliderQuality = (() => {
    const parsed = Number(qualityDraft);
    return qualityDraft.trim() && Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : props.quality;
  })();
  const selected = props.items.find((item) => item.id === props.selectedId) ?? props.items[0];
  const busy = selected && ["inspecting", "queued", "compressing"].includes(selected.status);
  const outputPath = selected?.status === "compressed" ? selected.outputPath : undefined;
  // Keep the selected original available for a later toggle, even if the source is moved.
  const originalPath = selected?.originalBytes ? selected.sourcePath : undefined;
  const original = useOptimizePreview(props.previews, selected?.id, originalPath, STAGE_PREVIEW_EDGE, props.active, selected?.taskVersion);
  const output = useOptimizePreview(props.previews, selected?.id, outputPath, STAGE_PREVIEW_EDGE, props.active && preview === "compressed");
  const previewUrl = output.url ?? original.url;
  const width = selected && preview === "compressed" && selected.status === "compressed" ? selected.outputWidth ?? selected.originalWidth : selected?.originalWidth;
  const height = selected && preview === "compressed" && selected.status === "compressed" ? selected.outputHeight ?? selected.originalHeight : selected?.originalHeight;

  const dropHandlers = {
    onDrop: props.onDrop,
    onDragOver: props.onDragOver,
    onDragLeave: props.onDragLeave,
  };

  return (
    <div className="bench-body">
      <section className="batch-rail" aria-label={t("Images to compress")}>
        <div className="rail-head">
          <span className="rail-title">
            {t("Batch")}
            <span className="rail-count">
              {props.items.length === 0 ? t("empty") : imageCount(props.items.length)}
            </span>
          </span>
          <div className="rail-tools">
            {props.items.length > 0 && (
              <Button type="button" variant="ghost" size="icon-xs" aria-label={t("Clear batch")} disabled={props.locked} onClick={props.onClear}><Trash2 className="size-3.5" /></Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="rail-choose"
              aria-label={t("Add images")}
              title={t("Add images")}
              data-testid="image-drop-zone"
              disabled={props.chooseDisabled}
              onClick={props.onChooseImages}
              {...dropHandlers}
            >
              <Plus className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
        <div className="batch-list" role="list">
          {props.items.map((item, index) => <LazyRender key={item.id} label={item.fileName} placeholder={<OptimizeItemSkeleton />} position={index + 1} total={props.items.length}>{() => <OptimizeItemCard item={item} previews={props.previews} active={props.active} selected={selected?.id === item.id} onSelect={props.onSelect} mutationLocked={props.locked} uploadFailure={props.uploadFailure(item.id)} uploading={props.isUploading(item.id)} onCancel={props.onCancel} onCompare={props.onCompare} onRemove={props.onRemove} onRetry={props.onRetry} />}</LazyRender>)}
          {!props.items.length && (
            <div className="rail-empty">
              <strong>{t("No images yet")}</strong>
              <p>{t("Add images to start a batch.")}</p>
            </div>
          )}
        </div>
      </section>

      <section className="stage" aria-label={t("Image preview")}>
        {selected && (
          <div className="stage-toolbar">
            <div role="group" aria-label={t("Preview version")} className="stage-toggle">
              <Button type="button" size="sm" variant="ghost" aria-pressed={preview === "original"} onClick={() => setPreview("original")}>{t("Original")}</Button>
              <Button type="button" size="sm" variant="ghost" aria-pressed={preview === "compressed"} onClick={() => setPreview("compressed")}>{t("Compressed")}</Button>
            </div>
            {selected.status === "compressed" && <Button type="button" size="sm" variant="ghost" onClick={() => props.onCompare(selected.id)} aria-label={t("Compare selected image at full resolution")}><Expand className="size-3.5" />{t("Compare")}</Button>}
          </div>
        )}

        <div className="stage-canvas">
          {!selected ? (
            <Button
              type="button"
              variant="ghost"
              disabled={props.chooseDisabled}
              className={cn("stage-drop", props.dragging && "is-dragging")}
              onClick={props.onChooseImages}
              {...dropHandlers}
            >
              <Plus className="drop-mark size-7" aria-hidden="true" />
              <span className="drop-title">{t("Drop images here")}</span>
              <span className="drop-cta">{t("Choose images")}</span>
              <span className="drop-formats">JPEG, PNG, WebP, AVIF, JPEG XL, HEIC</span>
            </Button>
          ) : previewUrl ? (
            <ImageWithSkeleton src={previewUrl} alt={!output.url ? t("Original preview of {{filename}}", { filename: selected.fileName }) : t("Compressed preview of {{filename}}", { filename: selected.fileName })} draggable={false} />
          ) : output.loading || original.loading || (busy && !originalPath) ? (
            <Skeleton className="image-skeleton" role="status" aria-label={t("Preparing your image")} />
          ) : (originalPath || outputPath) && !selected.error ? (
            <span className="image-load-error" role="status">{t("The image could not be decoded.")}</span>
          ) : (
            <div className="stage-empty">
              <ImageIcon className="drop-mark size-7" aria-hidden="true" />
              <strong>{selected.status === "failed" ? t("This image needs attention") : t("Preparing your image")}</strong>
              <p>{selected.error ?? t("The preview will appear as soon as the image is readable.")}</p>
            </div>
          )}
          {busy && <span className="stage-status" role="status">{selected.status === "inspecting" ? t("Reading image…") : selected.status === "queued" ? t("Waiting to compress…") : t("Updating preview…")}</span>}
        </div>

        {selected && (
          <div className="stage-readout">
            <span className="truncate">{selected.fileName}{width && height ? ` (${width} × ${height} px)` : ""}</span>
            <span className="numeric shrink-0">
              {selected.outputBytes !== undefined && selected.status === "compressed"
                ? <>{formatBytes(selected.originalBytes)} → {formatBytes(selected.outputBytes)}, <span className={selected.outputBytes > selected.originalBytes ? "larger" : "saved"}>{sizeChangeLabel(selected.originalBytes, selected.outputBytes)}</span></>
                : selected.originalBytes ? formatBytes(selected.originalBytes) : selected.settings.targetFormat === "jxl" ? "JPEG XL" : selected.settings.targetFormat.toUpperCase()}
            </span>
          </div>
        )}
      </section>

      <aside className="recipe" aria-label={t("Output settings")}>
        <div className="recipe-head">{t("Output")}<span>{t("Batch")}</span></div>
        <Label className="recipe-field recipe-preset">
          <span className="recipe-label">{t("Quick preset")}</span>
          <NativeSelect aria-label={t("Batch preset")} value={props.preset} onChange={(event) => props.onPreset(event.target.value as Exclude<CompressionPreset, "custom">)} disabled={props.locked}>
            <NativeSelectOption value="original">{t("Original format")}</NativeSelectOption>
            <NativeSelectOption value="balanced">{t("Balanced (WebP)")}</NativeSelectOption>
            <NativeSelectOption value="small">{t("Smaller (AVIF)")}</NativeSelectOption>
            <NativeSelectOption value="lossless">{t("Lossless (auto)")}</NativeSelectOption>
            <NativeSelectOption value="custom" disabled>{t("Custom")}</NativeSelectOption>
          </NativeSelect>
        </Label>
        <Label className="recipe-field recipe-format">
          <span className="recipe-label">{t("Output format")}</span>
          <NativeSelect aria-label={t("Batch format")} value={props.batchFormat} onChange={(event) => props.onBatchFormat(event.target.value as WritableImageFormat | "original")} disabled={props.locked}>
            <NativeSelectOption value="original">{t("Original format")}</NativeSelectOption>
            {AVAILABLE_OUTPUT_FORMATS.map((format) => <NativeSelectOption key={format} value={format}>{format === "jxl" ? "JPEG XL" : format.toUpperCase()}</NativeSelectOption>)}
          </NativeSelect>
        </Label>
        <div className="recipe-field">
          <div className="recipe-label"><Label htmlFor="output-quality">{t("Quality")}</Label><Input className="quality-input" aria-label={t("Quality:")} type="number" min={1} max={100} value={qualityDraft} disabled={props.locked || qualityNotApplicable} onChange={(event) => setQualityDraft(event.target.value)} onBlur={() => commitQuality()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitQuality(); } }} /></div>
          <Slider
            id="output-quality"
            aria-label={t("Quality")}
            value={sliderQuality}
            onValueChange={(value) => setQualityDraft(String(value))}
            onValueCommitted={(value) => commitQuality(String(value))}
            min={1}
            max={100}
            disabled={props.locked || qualityNotApplicable}
          />
          {qualityNotApplicable && <p className="recipe-note">{t("PNG output is lossless; quality does not apply.")}</p>}
        </div>
        <Label className="recipe-field">
          <span className="recipe-label">{t("Longest edge")}</span>
          <NativeSelect aria-label={t("Longest edge")} value={props.maxDimension} onChange={(event) => props.onMaxDimension(Number(event.target.value))} disabled={props.locked}>
            <NativeSelectOption value={0}>{t("Original")}</NativeSelectOption>
            {[3840, 2560, 1920, 1280, 960].map((size) => <NativeSelectOption key={size} value={size}>{size} {t("px")}</NativeSelectOption>)}
          </NativeSelect>
        </Label>
        {selected && <details className="image-format-details"><summary>{t("Current image")}</summary><Label className="recipe-field"><span className="recipe-label truncate">{selected.fileName}</span><NativeSelect aria-label={t("Format for {{value0}}", { value0: selected.fileName })} value={selected.settings.targetFormat} onChange={(event) => props.onFormat(selected.id, event.target.value as WritableImageFormat)} disabled={props.locked || selected.status === "inspecting" || selected.status === "cancelled"}>
          {AVAILABLE_OUTPUT_FORMATS.map((format) => <NativeSelectOption key={format} value={format}>{format === "jxl" ? "JPEG XL" : format.toUpperCase()}</NativeSelectOption>)}
        </NativeSelect></Label></details>}
        {selected?.originalAnimated && (
          <Label className="recipe-field">
            <span className="recipe-label">{t("Animation")}</span>
            <NativeSelect aria-label={t("Animation output")} value={selected.settings.animationMode ?? "preserve"} onChange={(event) => props.onAnimationMode(selected.id, event.target.value as "preserve" | "firstFrame")} disabled={props.locked || selected.status === "cancelled"}>
              <NativeSelectOption value="preserve" disabled={selected.sourceFormat !== "webp"}>{t("All frames")}</NativeSelectOption>
              <NativeSelectOption value="firstFrame">{t("First frame")}</NativeSelectOption>
            </NativeSelect>
          </Label>
        )}

        {(selected?.originalHDR || selected?.originalAnimated || (selected?.settings.targetFormat === "jxl" && props.quality === 100)) && <div className="recipe-notes">
          <p className="recipe-note">{selected?.originalHDR
            ? t("HDR preview and export are tone-mapped to SDR/sRGB. Originals stay HDR.")
            : selected?.originalAnimated
              ? selected.settings.animationMode === "firstFrame" ? t("First frame only selected. Your original animation stays untouched.") : t("WebP retains every frame. Choose a still image to export only the first frame.")
              : null}</p>
          {selected?.settings.targetFormat === "jxl" && props.quality === 100 && <p className="recipe-note">{t("JPEG XL at quality 100 preserves 8-bit pixels without loss. Use PNG for lossless high-bit-depth output.")}</p>}
        </div>}
      </aside>
    </div>
  );
}
