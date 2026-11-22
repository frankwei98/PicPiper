import { useEffect, useState } from "react";
import { imageApi } from "@/api/backend";

export const CARD_PREVIEW_EDGE = 96;
export const STAGE_PREVIEW_EDGE = 1024;
const cacheBytes = 8 * 1024 * 1024;

interface PendingPreview {
  taskId: string;
  readers: number;
  result: Promise<string | undefined>;
}

export class OptimizePreviews {
  private cached = new Map<string, string>();
  private pending = new Map<string, PendingPreview>();
  private bytes = 0;

  read(key: string, path: string, maxSize: number) {
    const cached = this.cached.get(key);
    if (cached !== undefined) {
      this.cached.delete(key);
      this.cached.set(key, cached);
      return { result: Promise.resolve(cached), release: () => {} };
    }

    let entry = this.pending.get(key);
    if (!entry) {
      const taskId = `preview:${crypto.randomUUID()}`;
      const result = imageApi.readThumbnail({ taskId, path, maxSize }).then(({ dataUrl }) => {
        if (this.pending.get(key)?.taskId === taskId) this.remember(key, dataUrl);
        return dataUrl;
      }, () => undefined).finally(() => {
        if (this.pending.get(key)?.taskId === taskId) this.pending.delete(key);
      });
      entry = { taskId, readers: 0, result };
      this.pending.set(key, entry);
    }
    entry.readers++;
    const { taskId, result } = entry;
    return {
      result,
      release: () => {
        const pending = this.pending.get(key);
        if (pending?.taskId !== taskId || --pending.readers > 0) return;
        this.pending.delete(key);
        void imageApi.cancelImageTask({ taskId }).catch(() => {});
      },
    };
  }

  clear() {
    for (const { taskId } of this.pending.values()) {
      void imageApi.cancelImageTask({ taskId }).catch(() => {});
    }
    this.pending.clear();
    this.cached.clear();
    this.bytes = 0;
  }

  private remember(key: string, url: string) {
    // Charge two bytes per character, including on engines that pack ASCII strings.
    const size = url.length * 2;
    if (size > cacheBytes) return;
    while (this.bytes + size > cacheBytes) {
      const oldest = this.cached.entries().next().value!;
      this.cached.delete(oldest[0]);
      this.bytes -= oldest[1].length * 2;
    }
    this.cached.set(key, url);
    this.bytes += size;
  }
}

export function useOptimizePreview(cache: OptimizePreviews, id: string | undefined, path: string | undefined, maxSize: number, active = true) {
  const key = path ? JSON.stringify([id, path, maxSize]) : undefined;
  const [response, setResponse] = useState<{ key: string; url: string | undefined }>();
  const current = response?.key === key ? response : undefined;
  const loaded = current?.url !== undefined;
  useEffect(() => {
    if (loaded) return;
    setResponse(undefined);
    if (!active || !key || !path) return;
    let live = true;
    const read = cache.read(key, path, maxSize);
    void read.result.then((url) => { if (live) setResponse({ key, url }); });
    return () => { live = false; read.release(); };
  }, [active, cache, key, loaded, maxSize, path]);

  return {
    url: active ? current?.url : undefined,
    loading: Boolean(active && key && !current),
  };
}
