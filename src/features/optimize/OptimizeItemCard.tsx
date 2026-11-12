import { Check, LoaderCircle, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { OptimizeItem, WritableImageFormat } from "../../types";
import { AVAILABLE_OUTPUT_FORMATS, formatBytes, sizeChangeLabel } from "./optimizeQueue";

interface OptimizeItemCardProps {
  item: OptimizeItem;
  selected?: boolean;
  onSelect?: (itemId: string) => void;
  mutationLocked: boolean;
  uploadFailure?: string;
  uploading: boolean;
  onCancel: (itemId: string) => void;
  onCompare: (itemId: string) => void;
  onFormatChange: (itemId: string, format: WritableImageFormat) => void;
  onRemove: (itemId: string) => void;
  onRetry: (itemId: string) => void;
}

export function OptimizeItemCard({ item, selected, onSelect, mutationLocked, uploadFailure, uploading, onCancel, onCompare, onFormatChange, onRemove, onRetry }: OptimizeItemCardProps) {
  const busy = ["inspecting", "queued", "compressing", "loadingPreview"].includes(item.status);
  const preview = item.compressedPreviewUrl ?? item.originalPreviewUrl;
  return (
    <article className={`compression-row${selected ? " compression-row-selected" : ""}`} aria-label={item.fileName}>
      <div className="compression-row-main">
        <button type="button" className="compression-row-thumb" aria-label={item.status === "compressed" ? `Compare ${item.fileName}` : `Preview ${item.fileName}`} onClick={() => item.status === "compressed" ? onCompare(item.id) : onSelect?.(item.id)}>
          {preview ? <img src={preview} alt="" loading="lazy" /> : <span>{item.sourceFormat === "unknown" ? "…" : item.sourceFormat.toUpperCase()}</span>}
        </button>
        <button type="button" className="compression-row-name" aria-label={`Select ${item.fileName}`} aria-pressed={Boolean(selected)} onClick={() => onSelect?.(item.id)}>
          <strong title={item.fileName}>{item.fileName}</strong>
          <span className="compression-row-status">
            {busy ? <><LoaderCircle className="size-3 animate-spin" aria-hidden="true" />{item.status === "inspecting" ? "Reading image…" : item.status === "queued" ? "Queued" : "Compressing..."}</> : item.status === "compressed" ? <><Check className="size-3" aria-hidden="true" />{formatBytes(item.originalBytes)} → {formatBytes(item.outputBytes ?? 0)}</> : item.status === "cancelled" ? "Cancelled" : "Needs attention"}
          </span>
        </button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${item.fileName}`} onClick={() => onRemove(item.id)} disabled={mutationLocked}><XIcon className="size-3" /></Button>
      </div>
      <div className="compression-row-controls">
        <NativeSelect aria-label={`Format for ${item.fileName}`} value={item.settings.targetFormat} onChange={(event) => onFormatChange(item.id, event.target.value as WritableImageFormat)} disabled={mutationLocked || item.status === "inspecting" || item.status === "cancelled"}>
          {AVAILABLE_OUTPUT_FORMATS.map((format) => <NativeSelectOption key={format} value={format}>{format === "jxl" ? "JPEG XL" : format.toUpperCase()}</NativeSelectOption>)}
        </NativeSelect>
        {item.status === "compressed" && <span className={item.outputBytes! > item.originalBytes ? "text-destructive" : "text-primary"}>{sizeChangeLabel(item.originalBytes, item.outputBytes ?? 0)}</span>}
        {busy && <Button variant="ghost" size="sm" aria-label={`Cancel ${item.fileName}`} onClick={() => onCancel(item.id)} disabled={mutationLocked}>Cancel</Button>}
        {(item.status === "failed" || item.status === "cancelled") && <Button variant="outline" size="sm" aria-label={`Retry ${item.fileName}`} onClick={() => onRetry(item.id)} disabled={mutationLocked}>Retry</Button>}
      </div>
      {selected && item.sourceWarning && <p className="compression-row-message">{item.sourceWarning}</p>}
      {selected && item.warning?.includes("High-bit-depth pixels") && <p className="compression-row-message">Output uses 8-bit pixels. Choose PNG to retain the source precision.</p>}
      {item.error && <p className="compression-row-message text-destructive" role="alert">{item.error}</p>}
      {item.status === "compressed" && (item.outputBytes ?? 0) > item.originalBytes && <p className="compression-row-message text-destructive">This output is larger. Try lower quality or a different target format before saving.</p>}
      {selected && item.warning?.includes("Transparency") && <p className="compression-row-message">Transparency was replaced with white for JPEG.</p>}
      {selected && item.settings.targetFormat === "png" && <p className="compression-row-message">PNG output is lossless; quality does not apply.</p>}
      {uploadFailure && <p className="compression-row-message text-destructive">{uploadFailure}</p>}
      {uploading && <p className="compression-row-message">Uploading...</p>}
    </article>
  );
}
