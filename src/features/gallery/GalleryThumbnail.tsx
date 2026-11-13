import { ImageWithSkeleton } from "@/components/ImageWithSkeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { useEffect, useRef, useState } from "react";
import { galleryApi } from "@/api/backend";
import { t } from "@/i18n";
import type { GalleryObject, S3Profile } from "@/types";

// Limit bridge work even when many tiles enter the viewport together. Queued
// work is discarded when its tile leaves the page or changes bucket/version.
const pending: Array<() => void> = [];
let active = 0;
function schedule(task: () => Promise<void>) {
  let cancelled = false;
  const run = () => {
    if (cancelled) { drain(); return; }
    active += 1;
    void task().finally(() => { active -= 1; drain(); });
  };
  const drain = () => { while (active < 2 && pending.length) pending.shift()?.(); };
  pending.push(run);
  drain();
  return () => { cancelled = true; const index = pending.indexOf(run); if (index >= 0) pending.splice(index, 1); };
}

export function GalleryThumbnail({ profile, object, onView }: { profile: S3Profile; object: GalleryObject; onView: () => void }) {
  const tile = useRef<HTMLButtonElement>(null);
  const [failedIdentity, setFailedIdentity] = useState<string>();
  const [preview, setPreview] = useState<{ identity: string; dataUrl: string }>();
  const identity = JSON.stringify([profile.id, profile.endpoint, profile.region, profile.bucket, profile.pathStyle, profile.accessKeyId, object.key, object.etag, object.size, object.lastModified]);
  useEffect(() => {
    let stopped = false;
    let cancel: (() => void) | undefined;
    const load = () => {
      if (cancel) return;
      cancel = schedule(async () => {
        try {
          const result = await galleryApi.readThumbnail({ profile, key: object.key, etag: object.etag, size: object.size, lastModified: object.lastModified });
          if (!stopped) setPreview({ identity, dataUrl: result.dataUrl });
        } catch { if (!stopped) setFailedIdentity(identity); }
      });
    };
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { load(); observer?.disconnect(); }
    }, { rootMargin: "200px" });
    if (observer && tile.current) observer.observe(tile.current); else load();
    return () => { stopped = true; observer?.disconnect(); cancel?.(); };
  }, [identity, profile, object.key, object.etag, object.size, object.lastModified]);
  return <button ref={tile} type="button" className="proof-thumbnail" aria-label={object.key} disabled={!object.publicUrl} onClick={onView}>
    {preview?.identity === identity ? <ImageWithSkeleton src={preview.dataUrl} alt={object.key} loading="lazy" /> : failedIdentity === identity ? <span>{t("Image")}</span> : <Skeleton className="image-skeleton" role="status" aria-label={t("Updating preview…")} />}
  </button>;
}
