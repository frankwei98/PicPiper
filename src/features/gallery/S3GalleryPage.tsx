import { useState } from "react";
import type { GalleryObject, S3Profile } from "../../types";
import type { GalleryFocus } from "../../state/appState";

interface S3GalleryPageProps {
  galleryFocus: GalleryFocus;
  profiles: S3Profile[];
}

export function S3GalleryPage({ galleryFocus, profiles }: S3GalleryPageProps) {
  const [objects] = useState<GalleryObject[]>([]);
  const highlightedKeys = new Set(galleryFocus.highlightedKeys);

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
        {objects.map((obj) => (
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
