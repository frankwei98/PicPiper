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
  // Retain only URLs in the WebView; the bounded PNGs live on disk until
  // their item leaves the batch.
  private originals = new Map<string, { url: string; taskId: string }>();
  private pending = new Map<string, PendingPreview>();
  private bytes = 0;

  read(key: string, path: string, maxSize: number) {
    const cached = this.cached.get(key);
    if (cached !== undefined) {
      this.cached.delete(key);
      this.cached.set(key, cached);
      return { result: Promise.resolve(cached), release: () => {} };
    }

    return this.load(key, async (taskId) => (await imageApi.readThumbnail({ taskId, path, maxSize })).dataUrl,
      (url) => this.remember(key, url));
  }

  readOriginal(id: string, path: string) {
    const cached = this.originals.get(id);
    if (cached) return { result: Promise.resolve(cached.url), release: () => {} };
    return this.load(`original:${id}`,
      async (taskId) => (await imageApi.readOriginalPreview({ taskId, path, maxSize: STAGE_PREVIEW_EDGE })).url,
      (url, taskId) => this.originals.set(id, { url, taskId }));
  }

  forgetOriginal(id: string) {
    const key = `original:${id}`;
    const taskId = this.originals.get(id)?.taskId ?? this.pending.get(key)?.taskId;
    this.originals.delete(id);
    this.pending.delete(key);
    if (taskId) this.cancel(taskId);
  }

  private load(key: string, read: (taskId: string) => Promise<string>, remember: (url: string, taskId: string) => void) {
    let entry = this.pending.get(key);
    if (!entry) {
      const taskId = `preview:${crypto.randomUUID()}`;
      const result = read(taskId).then((url) => {
        if (this.pending.get(key)?.taskId === taskId) remember(url, taskId);
        return url;
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
        this.cancel(taskId);
      },
    };
  }

  private cancel(taskId: string) {
    void imageApi.cancelImageTask({ taskId }).catch(() => {});
  }

  clear() {
    for (const { taskId } of this.originals.values()) this.cancel(taskId);
    for (const { taskId } of this.pending.values()) this.cancel(taskId);
    this.originals.clear();
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
  return usePreview(cache, id, path, maxSize, active, 0, false);
}

export function useOriginalPreview(cache: OptimizePreviews, id: string | undefined, path: string | undefined, active: boolean, retryVersion = 0) {
  return usePreview(cache, id, path, STAGE_PREVIEW_EDGE, active, retryVersion, true);
}

function usePreview(cache: OptimizePreviews, id: string | undefined, path: string | undefined, maxSize: number, active: boolean, retryVersion: number, original: boolean) {
  const key = path ? JSON.stringify([id, path, maxSize]) : undefined;
  const [response, setResponse] = useState<{ key: string; url: string | undefined; retryVersion: number }>();
  const current = response?.key === key && (response?.url !== undefined || response?.retryVersion === retryVersion) ? response : undefined;
  const loaded = current?.url !== undefined;
  useEffect(() => {
    if (loaded) return;
    setResponse(undefined);
    if (!active || !key || !path) return;
    let live = true;
    const read = original && id ? cache.readOriginal(id, path) : cache.read(key, path, maxSize);
    void read.result.then((url) => { if (live) setResponse({ key, url, retryVersion }); });
    return () => { live = false; read.release(); };
  }, [active, cache, id, key, loaded, maxSize, original, path, retryVersion]);

  return {
    url: active ? current?.url : undefined,
    loading: Boolean(active && key && !current),
  };
}
