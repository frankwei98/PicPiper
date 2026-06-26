import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { GalleryObject, S3Profile } from "../../types";
import type { GalleryFocus } from "../../state/appState";
import type { AppView } from "../../types";
import { galleryApi, namingApi, settingsApi, uploadApi } from "../../api/tauri";
import { AlertDialog } from "../../components/AlertDialog";

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
      const outputPath = `${dir}/${obj.key.split("/").pop()}`;
      await galleryApi.downloadObject({
        profile: selectedProfile,
        key: obj.key,
        outputPath,
      });
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
      <div className="page-stack">
        <header className="page-header">
          <div>
            <h2>S3 Gallery</h2>
            <p>Browse a profile and prefix, then copy URLs or manage images.</p>
          </div>
        </header>
        <section className="empty-state">
          No profile selected.
          {onNavigate && (
            <button className="btn-primary" type="button" onClick={() => onNavigate("settings")} style={{ marginTop: "var(--space-md)" }}>
              Add a profile in Settings
            </button>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h2>S3 Gallery</h2>
          <p>Browse a profile and prefix, then copy URLs or manage images.</p>
        </div>
        <button className="btn-primary" type="button" onClick={handleUploadLocal}>Upload local images</button>
      </header>
      <section className="gallery-toolbar">
        <select
          aria-label="Profile"
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
          placeholder="images/2026/06"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
        />
        <input
          aria-label="Search current prefix"
          placeholder="Search current prefix"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </section>
      {copyMessage && (
        <p className="status-line" role="status">{copyMessage}</p>
      )}
      {uploadStatus && (
        <p className={uploadStatus.includes("failed") ? "error-text" : "success-text"} role="status">{uploadStatus}</p>
      )}
      {loading && (
        <section className="gallery-grid" aria-label="Loading">
          {Array.from({ length: 6 }, (_, i) => (
            <article key={i} className="object-card">
              <div className="object-thumb" style={{ background: "var(--surface-container-high)" }} />
              <p style={{ height: "var(--fs-caption)", background: "var(--surface-container-high)", borderRadius: "var(--radius-sm)" }}>&nbsp;</p>
            </article>
          ))}
        </section>
      )}
      {deletingKey && <p className="status-line">Deleting {deletingKey}...</p>}
      {downloadingKey && <p className="status-line">Downloading {downloadingKey}...</p>}
      {error && <p className="error-text">{error}</p>}
      {!loading && !error && filteredObjects.length === 0 && (
        <section className="empty-state">
          No objects found.
          <button className="btn-primary" type="button" onClick={handleUploadLocal} style={{ marginTop: "var(--space-md)" }}>
            Upload local images
          </button>
        </section>
      )}
      {!loading && !error && filteredObjects.length > 0 && (
        <section className="gallery-grid">
          {filteredObjects.map((obj) => (
            <article
              key={obj.key}
              className={`object-card${highlightedKeys.has(obj.key) ? " highlighted" : ""}`}
            >
              <div className="object-thumb">
                {obj.isImage && obj.publicUrl ? (
                  <img
                    className="object-thumb-img"
                    src={obj.publicUrl}
                    alt={obj.key}
                    loading="lazy"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                      const fallback = (e.target as HTMLImageElement).parentElement?.querySelector(".thumb-fallback");
                      if (fallback) fallback.textContent = "Image";
                    }}
                  />
                ) : null}
                <span className="thumb-fallback">
                  {obj.isImage && !obj.publicUrl ? "Image" : !obj.isImage ? "File" : ""}
                </span>
              </div>
              <p>{obj.key}</p>
              <div className="object-actions">
                <button className="btn-secondary btn-sm" type="button" onClick={() => handleCopyUrl(obj)}>
                  Copy URL
                </button>
                <button className="btn-secondary btn-sm" type="button" onClick={() => handleView(obj)}>
                  View
                </button>
                <button className="btn-secondary btn-sm" type="button" onClick={() => handleDownload(obj)} disabled={downloadingKey !== null || deletingKey !== null}>
                  Download
                </button>
                <button className="btn-danger btn-sm" type="button" onClick={() => handleDeleteRequest(obj)} disabled={deletingKey !== null || downloadingKey !== null}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
      <AlertDialog
        open={deleteTarget !== null}
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
