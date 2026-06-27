import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { GalleryObject, S3Profile } from "../../types";
import type { GalleryFocus } from "../../state/appState";
import type { AppView } from "../../types";
import { galleryApi, namingApi, settingsApi, uploadApi } from "../../api/tauri";
import { AlertDialog } from "../../components/ui/Dialog";
import { cn } from "../../utils/cn";
import { StatusMessage } from "../../components/ui/Toast";

const btnBase = "border-none rounded-md cursor-pointer text-callout font-medium px-5 py-2.5 transition-[background-color,box-shadow,filter] duration-150 ease-out inline-flex items-center justify-center gap-sm leading-none focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-38 disabled:cursor-not-allowed disabled:pointer-events-none";
const btnPrimary = cn(btnBase, "bg-primary-container text-on-primary-container font-semibold hover:shadow-[0_1px_3px_rgba(0,0,0,0.3)] hover:brightness-110");
const btnSecondary = cn(btnBase, "bg-white/5 border border-outline-variant text-on-surface hover:bg-white/10 hover:border-outline");
const btnDanger = cn(btnBase, "bg-error-container text-on-error-container hover:brightness-115");
const btnSm = "text-footnote px-3 py-1.5 rounded-md";

const inputClass = "rounded-md border border-outline-variant bg-surface-container text-on-surface p-2.5 text-body transition-[border-color,box-shadow] duration-150 ease-out focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 w-full";

interface S3GalleryPageProps {
  galleryFocus: GalleryFocus;
  profiles: S3Profile[];
  onNavigate?: (view: AppView) => void;
}

export function S3GalleryPage({ galleryFocus, profiles, onNavigate }: S3GalleryPageProps) {
  const [selectedProfileId, setSelectedProfileId] = useState(
    galleryFocus.profile?.id ?? profiles[0]?.id ?? "",
  );
  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selectedProfileId) ?? profiles[0],
    [profiles, selectedProfileId],
  );
  const [prefix, setPrefix] = useState(
    galleryFocus.prefix || selectedProfile?.defaultPrefix || "",
  );
  const [objects, setObjects] = useState<GalleryObject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [namingTemplate, setNamingTemplate] = useState("{yyyy}/{mm}/{slug}-{hash}.{ext}");
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [highlightedKeysState, setHighlightedKeysState] = useState<string[]>(galleryFocus.highlightedKeys);
  const [deleteTarget, setDeleteTarget] = useState<GalleryObject | null>(null);
  const [imgErrors, setImgErrors] = useState<Set<string>>(new Set());

  const loadObjects = useCallback(async () => {
    if (!selectedProfile) return;
    setLoading(true);
    setError(null);
    try {
      const result = await galleryApi.listObjects({
        profile: selectedProfile,
        prefix,
      });
      setObjects(result);
      setImgErrors(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedProfile, prefix]);

  useEffect(() => {
    loadObjects();
  }, [loadObjects]);

  useEffect(() => {
    settingsApi.loadSettings().then((s) => setNamingTemplate(s.namingTemplate)).catch(() => {});
  }, []);

  const handleUploadLocal = async () => {
    if (!selectedProfile) return;
    setUploadStatus(null);
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
        const ext = fileName.split(".").pop() ?? "jpg";

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

  const handleDownload = async (obj: GalleryObject) => {
    if (!selectedProfile) return;
    setDownloadingKey(obj.key);
    try {
      const dir = await open({ directory: true });
      if (!dir) return;
      const resultPath = await galleryApi.downloadObject({
        profile: selectedProfile,
        key: obj.key,
        outputDir: dir,
      });
      setCopyMessage(`Saved to ${resultPath}`);
    } finally {
      setDownloadingKey(null);
    }
  };

  const handleDeleteRequest = (obj: GalleryObject) => {
    setDeleteTarget(obj);
  };

  const handleDeleteConfirm = async () => {
    if (!selectedProfile || !deleteTarget) return;
    setDeletingKey(deleteTarget.key);
    setDeleteTarget(null);
    try {
      await galleryApi.deleteObject({ profile: selectedProfile, key: deleteTarget.key });
      await loadObjects();
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
        <button className={btnPrimary} type="button" onClick={handleUploadLocal}>Upload local images</button>
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
            setPrefix(newProfile?.defaultPrefix ?? "");
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
                ) : null}
                <span className="text-caption opacity-60">
                  {!obj.isImage ? "File" : "Image"}
                </span>
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
