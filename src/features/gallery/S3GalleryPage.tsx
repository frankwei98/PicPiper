import type { GalleryObject, S3ProfileSummary } from "../../types";
import type { GalleryFocus } from "../../state/appState";

interface S3GalleryPageProps {
  galleryFocus: GalleryFocus;
  profiles: S3ProfileSummary[];
}

const SAMPLE_OBJECTS: GalleryObject[] = [
  {
    key: "2026/06/photo-01-abcdef12.webp",
    size: 720_000,
    publicUrl: "https://cdn.example.com/2026/06/photo-01-abcdef12.webp",
    isImage: true,
  },
];

export function S3GalleryPage({ galleryFocus }: S3GalleryPageProps) {
  const highlightedKeys = new Set(galleryFocus.highlightedKeys);

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h2>S3 Gallery</h2>
          <p>Browse a profile and prefix, then copy URLs or manage images.</p>
        </div>
        <button type="button">Upload local images</button>
      </header>
      <section className="gallery-toolbar">
        <select aria-label="Profile">
          <option>Choose profile</option>
        </select>
        <input aria-label="Prefix" placeholder="images/2026/06" />
        <input aria-label="Search current prefix" placeholder="Search current prefix" />
      </section>
      <section className="gallery-grid">
        {SAMPLE_OBJECTS.map((obj) => (
          <article
            key={obj.key}
            className={`object-card${highlightedKeys.has(obj.key) ? " highlighted" : ""}`}
          >
            <div className="object-thumb">
              {obj.isImage ? "Image" : "File"}
            </div>
            <p>{obj.key}</p>
            <div className="object-actions">
              <button type="button">Copy URL</button>
              <button type="button">View</button>
              <button type="button">Download</button>
              <button type="button">Delete</button>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
