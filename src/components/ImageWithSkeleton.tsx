import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { t } from "@/i18n";
import { Skeleton } from "@/components/ui/skeleton";

// A fragment keeps existing image sizing/scroll containers intact. The parent
// supplies position:relative so the skeleton covers the reserved image area.
export function ImageWithSkeleton({ src, alt, style, onLoad, onError, ...props }: ComponentProps<"img">) {
  const image = useRef<HTMLImageElement>(null);
  const [result, setResult] = useState<{ src: string | undefined; failed: boolean }>();
  const settled = result?.src === src;
  const failed = settled && result?.failed;
  useLayoutEffect(() => {
    if (image.current?.complete && image.current.naturalWidth > 0) setResult({ src, failed: false });
  }, [src]);
  return <>
    {!failed && <img {...props} ref={image} src={src} alt={alt} style={{ ...style, opacity: settled ? style?.opacity : 0 }}
      onLoad={(event) => { setResult({ src, failed: false }); onLoad?.(event); }}
      onError={(event) => { setResult({ src, failed: true }); onError?.(event); }} />}
    {!settled && <Skeleton className="image-skeleton" role="status" aria-label={t("Updating preview…")} />}
    {failed && <span className="image-load-error" role="status">{t("The image could not be decoded.")}</span>}
  </>;
}
