import { useEffect, useRef, useState } from "react";
import { ImageDown } from "lucide-react";
import { imageApi, miniApi } from "@/api/backend";

export function MiniThumbnail({ id }: { id?: string }) {
  const tile = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [preview, setPreview] = useState<{ id: string; url: string }>();

  useEffect(() => {
    if (!id || !tile.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "160px 0px" });
    observer.observe(tile.current);
    return () => observer.disconnect();
  }, [id]);

  useEffect(() => {
    setPreview(undefined);
    if (!id || !visible) return;
    const taskId = `mini-preview:${crypto.randomUUID()}`;
    let live = true;
    let pending = true;
    void miniApi.thumbnail(id, taskId).then(({ dataUrl }) => {
      if (live) setPreview({ id, url: dataUrl });
    }, () => {}).finally(() => { pending = false; });
    return () => {
      live = false;
      if (pending) void imageApi.cancelImageTask({ taskId }).catch(() => {});
    };
  }, [id, visible]);

  return <span className="mini-thumb" ref={tile}>
    {visible && preview && preview.id === id ? <img src={preview.url} alt="" /> : <ImageDown />}
  </span>;
}
