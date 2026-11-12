import { useState } from "react";
import { Expand, Image as ImageIcon, ImageUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import type { OptimizeItem, WritableImageFormat } from "../../types";
import { formatBytes, sizeChangeLabel } from "./optimizeQueue";
import { OptimizeItemCard } from "./OptimizeItemCard";

export type CompressionPreset = "original" | "balanced" | "small" | "lossless" | "custom";

interface OptimizeWorkspaceProps {
  items: OptimizeItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  quality: number;
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
  const [preview, setPreview] = useState<"original" | "compressed">("compressed");
  const selected = props.items.find((item) => item.id === props.selectedId) ?? props.items[0];
  const previewUrl = selected && (preview === "original" ? selected.originalPreviewUrl : selected.compressedPreviewUrl ?? selected.originalPreviewUrl);
  const busy = selected && ["inspecting", "queued", "compressing", "loadingPreview"].includes(selected.status);
  const width = selected && preview === "compressed" && selected.status === "compressed" ? selected.outputWidth ?? selected.originalWidth : selected?.originalWidth;
  const height = selected && preview === "compressed" && selected.status === "compressed" ? selected.outputHeight ?? selected.originalHeight : selected?.originalHeight;

  const dropHandlers = {
    onDrop: props.onDrop,
    onDragOver: props.onDragOver,
    onDragLeave: props.onDragLeave,
  };

  return (
    <div className="bench-body">
      <section className="batch-rail" aria-label="Images to compress">
        <div className="rail-head">
          <span className="rail-title">
            Batch
            <span className="rail-count">
              {props.items.length === 0 ? "empty" : `${props.items.length} ${props.items.length === 1 ? "image" : "images"}`}
            </span>
          </span>
          <div className="rail-tools">
            {props.items.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="rail-choose"
                data-testid="image-drop-zone"
                disabled={props.chooseDisabled}
                onClick={props.onChooseImages}
                {...dropHandlers}
              >
                Choose images
              </Button>
            )}
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Clear batch" disabled={!props.items.length || props.locked} onClick={props.onClear}><Trash2 className="size-3.5" /></Button>
          </div>
        </div>
        <div className="batch-list">
          {props.items.map((item) => <OptimizeItemCard key={item.id} item={item} selected={selected?.id === item.id} onSelect={props.onSelect} mutationLocked={props.locked} uploadFailure={props.uploadFailure(item.id)} uploading={props.isUploading(item.id)} onCancel={props.onCancel} onCompare={props.onCompare} onFormatChange={props.onFormat} onRemove={props.onRemove} onRetry={props.onRetry} />)}
          {!props.items.length && (
            <div className="rail-empty">
              <strong>No images yet</strong>
              <p>Add images to start a batch.</p>
            </div>
          )}
        </div>
      </section>

      <section className="stage" aria-label="Image preview">
        {selected && (
          <div className="stage-toolbar">
            <div role="group" aria-label="Preview version" className="stage-toggle">
              <Button type="button" size="sm" variant="ghost" aria-pressed={preview === "original"} onClick={() => setPreview("original")}>Original</Button>
              <Button type="button" size="sm" variant="ghost" aria-pressed={preview === "compressed"} onClick={() => setPreview("compressed")}>Compressed</Button>
            </div>
            {selected.status === "compressed" && <Button type="button" size="sm" variant="ghost" onClick={() => props.onCompare(selected.id)} aria-label="Compare selected image at full resolution"><Expand className="size-3.5" />Compare</Button>}
          </div>
        )}

        <div className="stage-canvas">
          {!selected ? (
            <Button
              type="button"
              variant="ghost"
              data-testid="image-drop-zone"
              disabled={props.chooseDisabled}
              className={cn("stage-drop", props.dragging && "is-dragging")}
              onClick={props.onChooseImages}
              {...dropHandlers}
            >
              <ImageUp className="drop-mark size-7" aria-hidden="true" />
              <span className="drop-title">Drop images here</span>
              <span className="drop-cta">Choose images</span>
              <span className="drop-formats">JPEG, PNG, WebP, AVIF, JPEG XL, HEIC</span>
            </Button>
          ) : previewUrl ? (
            <img src={previewUrl} alt={`${preview === "original" || !selected.compressedPreviewUrl ? "Original" : "Compressed"} preview of ${selected.fileName}`} draggable={false} />
          ) : (
            <div className="stage-empty">
              <ImageIcon className="drop-mark size-7" aria-hidden="true" />
              <strong>{selected.status === "failed" ? "This image needs attention" : "Preparing your image"}</strong>
              <p>{selected.error ?? "The preview will appear as soon as the image is readable."}</p>
            </div>
          )}
          {busy && <span className="stage-status" role="status">{selected.status === "inspecting" ? "Reading image…" : selected.status === "queued" ? "Waiting to compress…" : "Updating preview…"}</span>}
        </div>

        {selected && (
          <div className="stage-readout">
            <span className="truncate">Preview: {selected.fileName}{width && height ? ` (${width} × ${height} px)` : ""}</span>
            <span className="numeric shrink-0">
              {selected.outputBytes !== undefined && selected.status === "compressed"
                ? <>{formatBytes(selected.originalBytes)} → {formatBytes(selected.outputBytes)}, <span className={selected.outputBytes > selected.originalBytes ? "larger" : "saved"}>{sizeChangeLabel(selected.originalBytes, selected.outputBytes)}</span></>
                : selected.originalBytes ? formatBytes(selected.originalBytes) : selected.settings.targetFormat === "jxl" ? "JPEG XL" : selected.settings.targetFormat.toUpperCase()}
            </span>
          </div>
        )}
      </section>

      <aside className="recipe" aria-label="Output settings">
        <div className="recipe-head">Output</div>
        <Label className="recipe-field">
          <span className="recipe-label">Batch preset</span>
          <NativeSelect aria-label="Batch preset" value={props.preset} onChange={(event) => props.onPreset(event.target.value as Exclude<CompressionPreset, "custom">)} disabled={props.locked}>
            <NativeSelectOption value="original">Original format</NativeSelectOption>
            <NativeSelectOption value="balanced">Balanced (WebP)</NativeSelectOption>
            <NativeSelectOption value="small">Smaller (AVIF)</NativeSelectOption>
            <NativeSelectOption value="lossless">Lossless (auto)</NativeSelectOption>
            <NativeSelectOption value="custom" disabled>Custom</NativeSelectOption>
          </NativeSelect>
        </Label>
        <Label className="recipe-field">
          <span className="recipe-label">Quality <strong>{props.quality}</strong></span>
          <Slider aria-label="Quality" value={props.quality} onValueChange={props.onQuality} min={1} max={100} disabled={props.locked} />
        </Label>
        <Label className="recipe-field">
          <span className="recipe-label">Longest edge</span>
          <NativeSelect aria-label="Longest edge" value={props.maxDimension} onChange={(event) => props.onMaxDimension(Number(event.target.value))} disabled={props.locked}>
            <NativeSelectOption value={0}>Original</NativeSelectOption>
            {[3840, 2560, 1920, 1280, 960].map((size) => <NativeSelectOption key={size} value={size}>{size} px</NativeSelectOption>)}
          </NativeSelect>
        </Label>
        {selected?.originalAnimated && (
          <Label className="recipe-field">
            <span className="recipe-label">Animation</span>
            <NativeSelect aria-label="Animation output" value={selected.settings.animationMode ?? "preserve"} onChange={(event) => props.onAnimationMode(selected.id, event.target.value as "preserve" | "firstFrame")} disabled={props.locked || selected.status === "cancelled"}>
              <NativeSelectOption value="preserve" disabled={selected.sourceFormat !== "webp"}>All frames</NativeSelectOption>
              <NativeSelectOption value="firstFrame">First frame</NativeSelectOption>
            </NativeSelect>
          </Label>
        )}

        <div className="recipe-notes">
          <p className="recipe-note">{selected?.originalHDR
            ? "HDR preview and export are tone-mapped to SDR/sRGB. Originals stay HDR."
            : selected?.originalAnimated
              ? selected.settings.animationMode === "firstFrame" ? "First frame only selected. Your original animation stays untouched." : "WebP retains every frame. Choose a still image to export only the first frame."
              : "Presets and quality apply to the batch. All metadata and location data removed."}</p>
          {selected?.settings.targetFormat === "png" && <p className="recipe-note">PNG is lossless; quality does not apply.</p>}
          {selected?.settings.targetFormat === "jxl" && props.quality === 100 && <p className="recipe-note">JPEG XL at quality 100 preserves 8-bit pixels without loss. Use PNG for lossless high-bit-depth output.</p>}
        </div>
      </aside>
    </div>
  );
}
