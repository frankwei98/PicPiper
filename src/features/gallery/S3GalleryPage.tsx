export function S3GalleryPage() {
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
      <section className="empty-state">No profile selected.</section>
    </div>
  );
}
