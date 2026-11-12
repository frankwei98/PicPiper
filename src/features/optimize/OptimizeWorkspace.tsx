import { useState } from "react";
import { Expand, ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Slider } from "@/components/ui/slider";
import type { OptimizeItem, WritableImageFormat } from "../../types";
import { AVAILABLE_OUTPUT_FORMATS, formatBytes, sizeChangeLabel } from "./optimizeQueue";
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
}

export function OptimizeWorkspace(props: OptimizeWorkspaceProps) {
  const [preview, setPreview] = useState<"original" | "compressed">("compressed");
  const selected = props.items.find((item) => item.id === props.selectedId) ?? props.items[0];
  const previewUrl = selected && (preview === "original" ? selected.originalPreviewUrl : selected.compressedPreviewUrl ?? selected.originalPreviewUrl);
  const busy = selected && ["inspecting", "queued", "compressing", "loadingPreview"].includes(selected.status);
  const width = selected && preview === "compressed" && selected.status === "compressed" ? selected.outputWidth ?? selected.originalWidth : selected?.originalWidth;
  const height = selected && preview === "compressed" && selected.status === "compressed" ? selected.outputHeight ?? selected.originalHeight : selected?.originalHeight;

  return (
    <div className="compression-workbench">
      <section className="compression-batch" aria-label="Images to compress" onKeyDown={(event) => {
        if (!(event.target instanceof HTMLButtonElement) || !event.target.classList.contains("compression-row-name") || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const current = props.items.findIndex((item) => item.id === selected?.id);
        const next = event.key === "Home" ? 0 : event.key === "End" ? props.items.length - 1 : Math.max(0, Math.min(props.items.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
        props.onSelect(props.items[next].id);
        event.currentTarget.querySelectorAll<HTMLButtonElement>(".compression-row-name")[next]?.focus();
      }}>
        <div className="compression-batch-heading">
          <strong>Batch <span className="text-muted-foreground font-normal">{props.items.length}</span></strong>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Clear batch" disabled={!props.items.length || props.locked} onClick={props.onClear}><Trash2 className="size-3.5" /></Button>
        </div>
        <div className="compression-batch-list">
          {props.items.map((item) => <OptimizeItemCard key={item.id} item={item} selected={selected?.id === item.id} onSelect={props.onSelect} mutationLocked={props.locked} uploadFailure={props.uploadFailure(item.id)} uploading={props.isUploading(item.id)} onCancel={props.onCancel} onCompare={props.onCompare} onFormatChange={props.onFormat} onRemove={props.onRemove} onRetry={props.onRetry} />)}
          {!props.items.length && <div className="compression-list-empty"><ImagePlus className="size-6" /><p>Your images will appear here.</p><p>Originals always stay untouched.</p></div>}
        </div>
      </section>

      <aside className="compression-inspector" aria-label="Output settings">
        <Label className="compression-field">
          Batch preset
          <NativeSelect aria-label="Batch preset" value={props.preset} onChange={(event) => props.onPreset(event.target.value as Exclude<CompressionPreset, "custom">)} disabled={props.locked}>
            <NativeSelectOption value="original">Original format</NativeSelectOption>
            <NativeSelectOption value="balanced">Balanced · WebP</NativeSelectOption>
            <NativeSelectOption value="small">Smaller · AVIF</NativeSelectOption>
            <NativeSelectOption value="lossless">Lossless · Auto</NativeSelectOption>
            <NativeSelectOption value="custom" disabled>Custom</NativeSelectOption>
          </NativeSelect>
        </Label>
        <Label className="compression-field">
          Quality <span className="font-semibold text-foreground tabular-nums">{props.quality}</span>
          <Slider aria-label="Quality" value={props.quality} onValueChange={props.onQuality} min={1} max={100} disabled={props.locked} />
        </Label>
        {selected && <Label className="compression-field compression-selected-format">
          Selected output
          <NativeSelect aria-label="Selected output format" value={selected.settings.targetFormat} onChange={(event) => props.onFormat(selected.id, event.target.value as WritableImageFormat)} disabled={props.locked || selected.status === "inspecting" || selected.status === "cancelled"}>
            {AVAILABLE_OUTPUT_FORMATS.map((format) => <NativeSelectOption key={format} value={format}>{format === "jxl" ? "JPEG XL" : format.toUpperCase()}</NativeSelectOption>)}
          </NativeSelect>
        </Label>}
        <Label className="compression-field">
          Longest edge
          <NativeSelect aria-label="Longest edge" value={props.maxDimension} onChange={(event) => props.onMaxDimension(Number(event.target.value))} disabled={props.locked}>
            <NativeSelectOption value={0}>Original</NativeSelectOption>
            {[3840, 2560, 1920, 1280, 960].map((size) => <NativeSelectOption key={size} value={size}>{size} px</NativeSelectOption>)}
          </NativeSelect>
        </Label>
        {selected?.originalAnimated && <Label className="compression-field">
          Animation
          <NativeSelect aria-label="Animation output" value={selected.settings.animationMode ?? "preserve"} onChange={(event) => props.onAnimationMode(selected.id, event.target.value as "preserve" | "firstFrame")} disabled={props.locked || selected.status === "cancelled"}>
            <NativeSelectOption value="preserve" disabled={selected.sourceFormat !== "webp"}>All frames</NativeSelectOption>
            <NativeSelectOption value="firstFrame">First frame</NativeSelectOption>
          </NativeSelect>
        </Label>}
        <p className="compression-settings-note">{selected?.originalHDR
          ? "HDR preview and export are tone-mapped to SDR/sRGB. Originals stay HDR."
          : selected?.originalAnimated
            ? selected.settings.animationMode === "firstFrame" ? "First frame only selected. Your original animation stays untouched." : "WebP retains every frame. Choose a still image to export only the first frame."
            : "Presets and quality apply to the batch. All metadata and location data removed."}</p>
        {selected?.settings.targetFormat === "png" && <p className="compression-settings-note">PNG is lossless; quality does not apply.</p>}
        {selected?.settings.targetFormat === "jxl" && props.quality === 100 && <p className="compression-settings-note">JPEG XL at quality 100 preserves 8-bit pixels without loss. Use PNG for lossless high-bit-depth output.</p>}
      </aside>

      <section className="compression-stage" aria-label="Image preview">
        <div className="compression-stage-toolbar">
          <div role="group" aria-label="Preview version" className="flex gap-1">
            <Button size="sm" variant={preview === "original" ? "secondary" : "ghost"} aria-pressed={preview === "original"} onClick={() => setPreview("original")}>Original</Button>
            <Button size="sm" variant={preview === "compressed" ? "secondary" : "ghost"} aria-pressed={preview === "compressed"} onClick={() => setPreview("compressed")}>Compressed</Button>
          </div>
          {selected?.status === "compressed" && <Button size="sm" variant="ghost" onClick={() => props.onCompare(selected.id)} aria-label="Compare selected image at full resolution"><Expand className="size-3.5" />Compare</Button>}
        </div>
        <div className="compression-preview-canvas">
          {previewUrl ? <img src={previewUrl} alt={`${preview === "original" || !selected?.compressedPreviewUrl ? "Original" : "Compressed"} preview of ${selected?.fileName}`} draggable={false} /> : <div className="compression-preview-empty"><ImagePlus className="size-10" strokeWidth={1} /><strong>{selected ? selected.status === "failed" ? "This image needs attention" : "Preparing your image" : "Your preview appears here"}</strong><p>{selected?.error ?? "Drop a photo, screenshot, or a whole batch above."}</p></div>}
          {busy && <span className="compression-preview-status" role="status">{selected.status === "inspecting" ? "Reading image…" : selected.status === "queued" ? "Waiting to compress…" : "Updating preview…"}</span>}
        </div>
        <div className="compression-stage-caption">
          <span className="truncate">{selected ? `Preview: ${selected.fileName}${width && height ? ` · ${width} × ${height} px` : ""}` : "Private, local image processing"}</span>
          <span className="shrink-0 tabular-nums">{selected?.outputBytes !== undefined && selected.status === "compressed" ? `${formatBytes(selected.originalBytes)} → ${formatBytes(selected.outputBytes)} · ${sizeChangeLabel(selected.originalBytes, selected.outputBytes)}` : selected?.originalBytes ? formatBytes(selected.originalBytes) : "JPEG · PNG · WebP · AVIF · JPEG XL · HEIC"}</span>
        </div>
      </section>
    </div>
  );
}
