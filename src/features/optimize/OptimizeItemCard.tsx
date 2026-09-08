import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import type { OptimizeItem, WritableImageFormat } from "../../types";
import { AVAILABLE_OUTPUT_FORMATS, formatBytes, sizeChangeLabel } from "./optimizeQueue";

interface OptimizeItemCardProps {
  item: OptimizeItem;
  mutationLocked: boolean;
  uploadFailure?: string;
  uploading: boolean;
  onCancel: (itemId: string) => void;
  onCompare: (itemId: string) => void;
  onFormatChange: (itemId: string, format: WritableImageFormat) => void;
  onRemove: (itemId: string) => void;
  onRetry: (itemId: string) => void;
}

export function OptimizeItemCard({
  item,
  mutationLocked,
  uploadFailure,
  uploading,
  onCancel,
  onCompare,
  onFormatChange,
  onRemove,
  onRetry,
}: OptimizeItemCardProps) {
  return (
    <Card className="group relative transition-[transform,box-shadow] hover:-translate-y-px">
      <CardContent className="grid gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={`Remove ${item.fileName} from queue`}
          onClick={() => onRemove(item.id)}
          disabled={mutationLocked}
        >
          <XIcon className="size-3" />
        </Button>
        <div className="w-full aspect-square rounded-lg overflow-hidden bg-muted flex items-center justify-center">
          {item.status === "compressed" && item.compressedPreviewUrl ? (
            <Button
              className="h-full w-full rounded-none p-0"
              variant="ghost"
              type="button"
              aria-label={`Compare ${item.fileName}`}
              onClick={() => onCompare(item.id)}
            >
              <img
                src={item.compressedPreviewUrl}
                alt=""
                loading="lazy"
                className="w-full h-full object-cover block"
              />
            </Button>
          ) : item.originalPreviewUrl ? (
            <img
              src={item.originalPreviewUrl}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover block"
            />
          ) : (
            <Skeleton className="h-full w-full" aria-hidden="true" />
          )}
        </div>
        <div className="flex flex-col gap-1 min-w-0">
          <strong className="text-sm font-semibold overflow-hidden text-ellipsis whitespace-nowrap">
            {item.fileName}
          </strong>
          {item.error ? (
            <p className="text-destructive text-xs mt-0.5">{item.error}</p>
          ) : item.status === "cancelled" ? (
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty">Cancelled</p>
          ) : item.status === "compressing" || item.status === "loadingPreview" ? (
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty tabular-nums">
              Compressing...
            </p>
          ) : item.status === "compressed" ? (
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty tabular-nums">
              {formatBytes(item.originalBytes)} {String.fromCodePoint(0x2192)}{" "}
              {formatBytes(item.outputBytes ?? 0)} ({sizeChangeLabel(item.originalBytes, item.outputBytes ?? 0)})
            </p>
          ) : item.originalBytes > 0 ? (
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty tabular-nums">
              {item.sourceFormat.toUpperCase()} {String.fromCodePoint(0x2192)}{" "}
              {item.settings.targetFormat.toUpperCase()} | {formatBytes(item.originalBytes)}
            </p>
          ) : null}
          {item.status === "compressed" && (item.outputBytes ?? 0) > item.originalBytes && (
            <p className="text-destructive text-xs text-pretty" role="status">
              This output is larger. Try lower quality or a different target format before saving.
            </p>
          )}
          {item.warning && (
            <p className="text-muted-foreground text-xs mt-0.5">{item.warning}</p>
          )}
          {item.settings.targetFormat === "png" && (
            <p className="text-muted-foreground text-xs mt-0.5">
              Quality does not apply to PNG output.
            </p>
          )}
          {item.status !== "inspecting" && item.status !== "cancelled" && !item.error && (
            <Label className="flex flex-col items-start gap-2 mt-2 text-xs text-muted-foreground">
              <NativeSelect
                aria-label={`Format for ${item.fileName}`}
                className="w-full"
                value={item.settings.targetFormat}
                onChange={(event) =>
                  onFormatChange(item.id, event.target.value as WritableImageFormat)
                }
                disabled={mutationLocked}
              >
                {AVAILABLE_OUTPUT_FORMATS.map((format) => (
                  <NativeSelectOption key={format} value={format}>
                    {format.toUpperCase()}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Label>
          )}
          {uploadFailure && <p className="text-destructive text-xs mt-0.5">{uploadFailure}</p>}
          {uploading && <p className="text-muted-foreground text-xs mt-0.5">Uploading...</p>}
          {(item.status === "inspecting" ||
            item.status === "queued" ||
            item.status === "compressing" ||
            item.status === "loadingPreview") && (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              aria-label={`Cancel ${item.fileName}`}
              onClick={() => onCancel(item.id)}
              disabled={mutationLocked}
            >
              Cancel
            </Button>
          )}
          {(item.status === "failed" || item.status === "cancelled") && (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              aria-label={`Retry ${item.fileName}`}
              onClick={() => onRetry(item.id)}
              disabled={mutationLocked}
            >
              Retry
            </Button>
          )}
          {(item.status === "compressed" ||
            item.status === "failed" ||
            item.status === "cancelled") && (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              aria-label={`Remove ${item.fileName}`}
              onClick={() => onRemove(item.id)}
              disabled={mutationLocked}
            >
              Remove
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
