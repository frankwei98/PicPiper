import { ImageWithSkeleton } from "@/components/ImageWithSkeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { t, useLocale } from "@/i18n";
import { Check, LoaderCircle, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OptimizeItem } from "../../types";
import { formatBytes, sizeChangeLabel } from "./optimizeQueue";
import { CARD_PREVIEW_EDGE, STAGE_PREVIEW_EDGE, useOptimizePreview, type OptimizePreviews } from "./optimizePreviews";

interface OptimizeItemCardProps {
  item: OptimizeItem;
  previews: OptimizePreviews;
  active: boolean;
  selected?: boolean;
  onSelect?: (itemId: string) => void;
  mutationLocked: boolean;
  uploadFailure?: string;
  uploading: boolean;
  onCancel: (itemId: string) => void;
  onCompare: (itemId: string) => void;
  onRemove: (itemId: string) => void;
  onRetry: (itemId: string) => void;
}

export function OptimizeItemCard({ item, previews, active, selected, onSelect, mutationLocked, uploadFailure, uploading, onCancel, onCompare, onRemove, onRetry }: OptimizeItemCardProps) {
  useLocale();
  const busy = ["inspecting", "queued", "compressing"].includes(item.status);
  const preview = useOptimizePreview(previews, item.id, item.status === "compressed" ? item.outputPath : undefined, selected ? STAGE_PREVIEW_EDGE : CARD_PREVIEW_EDGE, active);
  return (
    <article className={cn("batch-item", selected && "selected")} aria-label={item.fileName} data-output-format={item.settings.targetFormat}>
      <div className="item-main">
        <Button
          type="button"
          variant="ghost"
          className="item-thumb"
          aria-label={item.status === "compressed" ? t("Compare {{value0}}", { value0: item.fileName }) : t("Preview {{value0}}", { value0: item.fileName })}
          onClick={() => item.status === "compressed" ? onCompare(item.id) : onSelect?.(item.id)}
        >
          {preview.url ? <ImageWithSkeleton src={preview.url} alt="" loading="lazy" /> : busy || preview.loading ? <Skeleton className="image-skeleton" role="status" aria-label={t("Updating preview…")} /> : <span>{item.sourceFormat === "unknown" ? "…" : item.sourceFormat.toUpperCase()}</span>}
        </Button>
        <Button type="button" variant="ghost" className="item-name" aria-label={t("Select {{value0}}", { value0: item.fileName })} aria-pressed={Boolean(selected)} onClick={() => onSelect?.(item.id)}>
          <strong title={item.fileName}>{item.fileName}</strong>
          <span className="item-status">
            {busy ? <><LoaderCircle className="size-3 animate-spin" aria-hidden="true" />{item.status === "inspecting" ? t("Reading image…") : item.status === "queued" ? t("Queued") : t("Compressing...")}</> : item.status === "compressed" ? <><Check className="size-3" aria-hidden="true" />{formatBytes(item.originalBytes)} → {formatBytes(item.outputBytes ?? 0)}</> : item.status === "cancelled" ? t("Cancelled") : t("Needs attention")}
          </span>
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" className="item-remove" aria-label={t("Remove {{value0}}", { value0: item.fileName })} onClick={() => onRemove(item.id)} disabled={mutationLocked}><XIcon className="size-3" /></Button>
      </div>
      <div className="item-controls">
        <span className="item-output-format">{item.settings.targetFormat === "jxl" ? "JPEG XL" : item.settings.targetFormat.toUpperCase()}</span>
        {item.status === "compressed" && <span className={cn("item-delta", item.outputBytes! > item.originalBytes ? "larger" : "saved")}>{sizeChangeLabel(item.originalBytes, item.outputBytes ?? 0)}</span>}
        {busy && <Button type="button" variant="ghost" size="xs" className="item-action" aria-label={t("Cancel {{value0}}", { value0: item.fileName })} onClick={() => onCancel(item.id)} disabled={mutationLocked}>{t("Cancel")}</Button>}
        {(item.status === "failed" || item.status === "cancelled") && <Button type="button" variant="ghost" size="xs" className="item-action" aria-label={t("Retry {{value0}}", { value0: item.fileName })} onClick={() => onRetry(item.id)} disabled={mutationLocked}>{t("Retry")}</Button>}
        {uploading && <span className="item-status">{t("Uploading…")}</span>}
      </div>
      {selected && item.sourceWarning && <p className="item-message">{item.sourceWarning}</p>}
      {selected && item.warning?.includes("High-bit-depth pixels") && <p className="item-message">{t("Output uses 8-bit pixels. Choose PNG to retain the source precision.")}</p>}
      {item.error && <p className="item-message danger" role="alert">{item.error}</p>}
      {selected && item.status === "compressed" && (item.outputBytes ?? 0) > item.originalBytes && <p className="item-message danger">{t("This output is larger. Try lower quality or a different target format before saving.")}</p>}
      {selected && item.warning?.includes("Transparency") && <p className="item-message">{t("Transparency was replaced with white for JPEG.")}</p>}
      {uploadFailure && <p className="item-message danger">{uploadFailure}</p>}
      {uploading && <p className="item-message">{t("Uploading...")}</p>}
    </article>
  );
}
