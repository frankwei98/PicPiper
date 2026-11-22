import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ImageDown } from "lucide-react";
import { imageApi, miniApi } from "@/api/backend";

// Keep a small window of 96 px thumbnails in each open panel.
const cachedThumbnailLimit = 24;

interface MiniThumbnailProps {
  id?: string;
  scrollContainer: RefObject<HTMLDivElement | null>;
  cache: Map<string, string>;
}

export function MiniThumbnail({ id, scrollContainer, cache }: MiniThumbnailProps) {
  const tile = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [preview, setPreview] = useState<{ id: string; url: string }>();

  useEffect(() => {
    const root = scrollContainer.current;
    if (!id || !root || !tile.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root, rootMargin: "160px 0px" });
    observer.observe(tile.current);
    return () => observer.disconnect();
  }, [id, scrollContainer]);

  useLayoutEffect(() => {
    if (!id || !visible) {
      setPreview(undefined);
      return;
    }
    const cached = cache.get(id);
    if (cached) {
      cache.delete(id);
      cache.set(id, cached);
      setPreview({ id, url: cached });
      return;
    }
    const taskId = `mini-preview:${crypto.randomUUID()}`;
    let live = true;
    let pending = true;
    void miniApi.thumbnail(id, taskId).then(({ dataUrl }) => {
      if (!live || !dataUrl) return;
      cache.set(id, dataUrl);
      if (cache.size > cachedThumbnailLimit) cache.delete(cache.keys().next().value!);
      setPreview({ id, url: dataUrl });
    }, () => {}).finally(() => { pending = false; });
    return () => {
      live = false;
      if (pending) void imageApi.cancelImageTask({ taskId }).catch(() => {});
    };
  }, [cache, id, visible]);

  return <span className="mini-thumb" ref={tile}>
    {visible && preview && preview.id === id ? <img src={preview.url} alt="" /> : <ImageDown />}
  </span>;
}
