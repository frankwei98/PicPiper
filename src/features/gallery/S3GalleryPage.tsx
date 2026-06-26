import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { GalleryObject, S3Profile } from "../../types";
import type { GalleryFocus } from "../../state/appState";
import { galleryApi, namingApi, settingsApi, uploadApi } from "../../api/tauri";

interface S3GalleryPageProps {
  galleryFocus: GalleryFocus;
  profiles: S3Profile[];
}

export function S3GalleryPage({ galleryFocus, profiles }: S3GalleryPageProps) {
  const selectedProfile = galleryFocus.profile ?? profiles[0];
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
  const [highlightedKeysState, setHighlightedKeysState] = useState<string[]>(galleryFocus.highlightedKeys);

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
    const dir = await open({ directory: true });
    if (!dir) return;
    const outputPath = `${dir}/${obj.key.split("/").pop()}`;
    await galleryApi.downloadObject({
      profile: selectedProfile,
      key: obj.key,
      outputPath,
    });
  };

  const handleDelete = async (obj: GalleryObject) => {
    if (!selectedProfile) return;
    if (!window.confirm(`Delete ${obj.key}?`)) return;
    await galleryApi.deleteObject({ profile: selectedProfile, key: obj.key });
    await loadObjects();
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
        <section className="empty-state">No profile selected.</section>
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
        <button type="button" onClick={handleUploadLocal}>Upload local images</button>
      </header>
      <section className="gallery-toolbar">
        <select aria-label="Profile" value={selectedProfile?.id ?? ""}>
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
        <section className="copy-message" role="status">
          {copyMessage}
        </section>
      )}
      {uploadStatus && (
        <section className="upload-status" role="status">
          {uploadStatus}
        </section>
      )}
      {loading && <section className="loading-state">Loading...</section>}
      {error && <section className="error-state">{error}</section>}
      {!loading && !error && filteredObjects.length === 0 && (
        <section className="empty-state">No objects found.</section>
      )}
      {!loading && !error && filteredObjects.length > 0 && (
        <section className="gallery-grid">
          {filteredObjects.map((obj) => (
            <article
              key={obj.key}
              className={`object-card${highlightedKeys.has(obj.key) ? " highlighted" : ""}`}
            >
              <div className="object-thumb">
                {obj.isImage ? "Image" : "File"}
              </div>
              <p>{obj.key}</p>
              <div className="object-actions">
                <button type="button" onClick={() => handleCopyUrl(obj)}>
                  Copy URL
                </button>
                <button type="button" onClick={() => handleView(obj)}>
                  View
                </button>
                <button type="button" onClick={() => handleDownload(obj)}>
                  Download
                </button>
                <button type="button" onClick={() => handleDelete(obj)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
