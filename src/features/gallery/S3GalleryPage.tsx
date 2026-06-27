import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { GalleryObject, S3Profile } from "../../types";
import type { GalleryFocus } from "../../state/appState";
import type { AppView } from "../../types";
import { galleryApi, namingApi, uploadApi } from "../../api/tauri";
import { AlertDialog } from "../../components/ui/Dialog";
import { cn } from "../../utils/cn";
import { StatusMessage } from "../../components/ui/Toast";
import { btnPrimary, btnSecondary, btnDanger, btnSm, inputClass } from "../../components/ui/buttonStyles";

interface S3GalleryPageProps {
  galleryFocus: GalleryFocus;
  profiles: S3Profile[];
  defaultProfileId?: string;
  namingTemplate?: string;
  onNavigate?: (view: AppView) => void;
}

export function S3GalleryPage({ galleryFocus, profiles, defaultProfileId, namingTemplate: namingTemplateProp, onNavigate }: S3GalleryPageProps) {
  const resolveDefaultId = () =>
    galleryFocus.profileId ?? defaultProfileId ?? profiles[0]?.id ?? "";
  const [selectedProfileId, setSelectedProfileId] = useState(resolveDefaultId);
  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selectedProfileId) ?? profiles[0],
    [profiles, selectedProfileId],
  );
  const [prefix, setPrefix] = useState(
    galleryFocus.prefix || selectedProfile?.defaultPrefix || "",
  );
  const [debouncedPrefix, setDebouncedPrefix] = useState(prefix);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce prefix changes for API calls
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedPrefix(prefix);
    }, 350);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [prefix]);

  // Sync profile and prefix when galleryFocus changes externally
  useEffect(() => {
    if (galleryFocus.profileId) {
      setSelectedProfileId(galleryFocus.profileId);
      const p = profiles.find((pr) => pr.id === galleryFocus.profileId);
      if (p && !galleryFocus.prefix) {
        const newPrefix = p.defaultPrefix || "";
        setPrefix(newPrefix);
        setDebouncedPrefix(newPrefix); // immediate for programmatic changes
      }
    }
    if (galleryFocus.prefix) {
      setPrefix(galleryFocus.prefix);
      setDebouncedPrefix(galleryFocus.prefix); // immediate for programmatic changes
    }
  }, [galleryFocus.profileId, galleryFocus.prefix, profiles]);
  const [objects, setObjects] = useState<GalleryObject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const namingTemplate = namingTemplateProp ?? "{yyyy}/{mm}/{slug}-{hash}.{ext}";
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [highlightedKeysState, setHighlightedKeysState] = useState<string[]>(galleryFocus.highlightedKeys);
  const [deleteTarget, setDeleteTarget] = useState<GalleryObject | null>(null);
  const [imgErrors, setImgErrors] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);

  const loadObjects = useCallback(async () => {
    if (!selectedProfile) return;
    setLoading(true);
    setError(null);
    try {
      const result = await galleryApi.listObjects({
        profile: selectedProfile,
        prefix: debouncedPrefix,
      });
      setObjects(result);
      setImgErrors(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedProfile, debouncedPrefix]);

  useEffect(() => {
    loadObjects();
  }, [loadObjects]);

  const handleUploadLocal = async () => {
    if (!selectedProfile || uploading) return;
    setUploadStatus(null);
    setUploading(true);
    try {
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "Images",
            extensions: ["jpg", "jpeg", "png", "webp", "avif", "heif", "heic"],
          },
        ],
      });
      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      const currentPrefix = prefix || selectedProfile.defaultPrefix || "images";
      const newKeys: string[] = [];

      for (const filePath of paths) {
        const fileName = filePath.split("/").pop() ?? "image";
        const dotIndex = fileName.lastIndexOf(".");
        const ext = dotIndex > 0 ? fileName.substring(dotIndex + 1) : "jpg";

        const { objectKey } = await namingApi.generateObjectKey({
          sourcePath: filePath,
          outputFileName: fileName,
          prefix: currentPrefix,
          namingTemplate,
          ext,
        });

        const contentTypeMap: Record<string, string> = {
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
          avif: "image/avif",
          heif: "image/heif",
          heic: "image/heic",
        };

        await uploadApi.uploadObject({
          profile: selectedProfile,
          sourcePath: filePath,
          objectKey,
          contentType: contentTypeMap[ext] ?? "application/octet-stream",
        });

        newKeys.push(objectKey);
      }

      setHighlightedKeysState(newKeys);
      setUploadStatus(`Uploaded ${newKeys.length} image(s).`);
      await loadObjects();
    } catch (err) {
      setUploadStatus(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const highlightedKeys = useMemo(
    () => new Set([...galleryFocus.highlightedKeys, ...highlightedKeysState]),
    [galleryFocus.highlightedKeys, highlightedKeysState],
  );

  const filteredObjects = useMemo(() => {
    if (!search.trim()) return objects;
    const q = search.toLowerCase();
    return objects.filter((obj) => obj.key.toLowerCase().includes(q));
  }, [objects, search]);

  const handleCopyUrl = async (obj: GalleryObject) => {
    if (!obj.publicUrl) {
      setCopyMessage("Public Base URL missing");
      return;
    }
    try {
      await navigator.clipboard.writeText(obj.publicUrl);
      setCopyMessage("URL copied");
    } catch {
      setCopyMessage("Failed to copy URL");
    }
  };

  const handleView = (obj: GalleryObject) => {
    if (obj.publicUrl) {
      window.open(obj.publicUrl, "_blank");
    }
  };

  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownload = async (obj: GalleryObject) => {
    if (!selectedProfile) return;
    setDownloadingKey(obj.key);
    setDownloadError(null);
    try {
      const dir = await open({ directory: true });
      if (!dir) {
        setDownloadingKey(null);
        return;
      }
      const resultPath = await galleryApi.downloadObject({
        profile: selectedProfile,
        key: obj.key,
        outputDir: dir,
      });
      setCopyMessage(`Saved to ${resultPath}`);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloadingKey(null);
    }
  };

  const handleDeleteRequest = (obj: GalleryObject) => {
    setDeleteTarget(obj);
  };

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDeleteConfirm = async () => {
    if (!selectedProfile || !deleteTarget) return;
    const targetKey = deleteTarget.key;
    setDeletingKey(targetKey);
    setDeleteTarget(null);
    setDeleteError(null);
    try {
      await galleryApi.deleteObject({ profile: selectedProfile, key: targetKey });
      await loadObjects();
    } catch (err) {
      setDeleteError(`Failed to delete ${targetKey}: ${err instanceof Error ? err.message : "Delete failed"}`);
    } finally {
      setDeletingKey(null);
    }
  };

  if (profiles.length === 0) {
    return (
      <div className="grid gap-lg max-w-page">
        <header className="flex justify-between items-start gap-lg">
          <div>
            <h2 className="text-large-title font-bold text-on-surface text-balance">S3 Gallery</h2>
            <p className="text-on-surface-variant mt-xs text-body text-pretty">Browse a profile and prefix, then copy URLs or manage images.</p>
          </div>
        </header>
        <section className="border border-dashed border-outline-variant rounded-lg bg-surface-container-low p-2xl text-center text-on-surface-variant text-callout">
          No profile selected.
          {onNavigate && (
            <button className={cn(btnPrimary, "mt-md")} type="button" onClick={() => onNavigate("settings")}>
              Add a profile in Settings
            </button>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="grid gap-lg max-w-page">
      <header className="flex justify-between items-start gap-lg">
        <div>
          <h2 className="text-large-title font-bold text-on-surface text-balance">S3 Gallery</h2>
          <p className="text-on-surface-variant mt-xs text-body text-pretty">Browse a profile and prefix, then copy URLs or manage images.</p>
        </div>
        <button className={btnPrimary} type="button" onClick={handleUploadLocal} disabled={uploading}>{uploading ? "Uploading…" : "Upload local images"}</button>
      </header>
      <section className="grid gap-sm grid-cols-3 max-md:grid-cols-1">
        <select
          aria-label="Profile"
          className={inputClass}
          value={selectedProfile?.id ?? ""}
          onChange={(e) => {
            const newId = e.target.value;
            setSelectedProfileId(newId);
            const newProfile = profiles.find((p) => p.id === newId);
            const newPrefix = newProfile?.defaultPrefix ?? "";
            setPrefix(newPrefix);
            setDebouncedPrefix(newPrefix); // immediate for programmatic changes
          }}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          aria-label="Prefix"
          className={inputClass}
          placeholder="images/2026/06"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
        />
        <input
          aria-label="Search current prefix"
          className={inputClass}
          placeholder="Search current prefix"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </section>
      {copyMessage && (
        <StatusMessage>{copyMessage}</StatusMessage>
      )}
      {uploadStatus && (
        <StatusMessage variant={uploadStatus.includes("failed") ? "error" : "default"}>{uploadStatus}</StatusMessage>
      )}
      {loading && (
        <section className="grid gap-md grid-cols-[repeat(auto-fill,minmax(200px,1fr))]" aria-label="Loading">
          {Array.from({ length: 6 }, (_, i) => (
            <article key={i} className="bg-surface-container border border-outline-variant rounded-md grid gap-sm p-md">
              <div className="aspect-[4/3] bg-surface-container-high rounded-xs" aria-hidden="true" />
              <p className="h-[var(--text-caption)] bg-surface-container-high rounded-xs" aria-hidden="true">&nbsp;</p>
            </article>
          ))}
        </section>
      )}
      {deletingKey && <StatusMessage>Deleting {deletingKey}...</StatusMessage>}
      {downloadingKey && <StatusMessage>Downloading {downloadingKey}...</StatusMessage>}
      {deleteError && <StatusMessage variant="error">{deleteError}</StatusMessage>}
      {downloadError && <StatusMessage variant="error">{downloadError}</StatusMessage>}
      {error && <StatusMessage variant="error">{error}</StatusMessage>}
      {!loading && !error && filteredObjects.length === 0 && (
        <section className="border border-dashed border-outline-variant rounded-lg bg-surface-container-low p-2xl text-center text-on-surface-variant text-callout">
          No objects found.
          <button className={cn(btnPrimary, "mt-md")} type="button" onClick={handleUploadLocal}>
            Upload local images
          </button>
        </section>
      )}
      {!loading && !error && filteredObjects.length > 0 && (
        <section className="grid gap-md grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
          {filteredObjects.map((obj) => (
            <article
              key={obj.key}
              className={cn(
                "bg-surface-container border border-outline-variant rounded-md grid gap-sm p-md",
                "transition-[border-color,transform] duration-200 ease-out",
                "hover:border-outline hover:-translate-y-px",
                highlightedKeys.has(obj.key) && "border-primary shadow-[0_0_0_1px_var(--primary)]",
              )}
            >
              <div className="aspect-[4/3] bg-surface-container-high rounded-xs text-on-surface-variant flex justify-center items-center overflow-hidden text-caption">
                {obj.isImage && obj.publicUrl && !imgErrors.has(obj.key) ? (
                  <img
                    className="w-full h-full object-cover rounded-xs"
                    src={obj.publicUrl}
                    alt={obj.key}
                    loading="lazy"
                    onError={() => setImgErrors((prev) => new Set(prev).add(obj.key))}
                  />
                ) : (
                  <span className="text-caption opacity-60">
                    {!obj.isImage ? "File" : "Image"}
                  </span>
                )}
              </div>
              <p className="text-caption text-on-surface-variant overflow-hidden text-ellipsis whitespace-nowrap text-pretty tabular-nums">{obj.key}</p>
              <div className="grid gap-1 grid-cols-2">
                <button className={cn(btnSecondary, btnSm)} type="button" onClick={() => handleCopyUrl(obj)}>
                  Copy URL
                </button>
                <button className={cn(btnSecondary, btnSm)} type="button" onClick={() => handleView(obj)}>
                  View
                </button>
                <button className={cn(btnSecondary, btnSm)} type="button" onClick={() => handleDownload(obj)} disabled={downloadingKey !== null || deletingKey !== null}>
                  Download
                </button>
                <button className={cn(btnDanger, btnSm)} type="button" onClick={() => handleDeleteRequest(obj)} disabled={deletingKey !== null || downloadingKey !== null}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={`Delete ${deleteTarget?.key ?? ""}?`}
        description="This will permanently remove the object from S3. This action cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
