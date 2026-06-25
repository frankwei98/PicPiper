export function SettingsPage() {
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h2>Settings</h2>
          <p>Manage S3 profiles, presets, naming, and output defaults.</p>
        </div>
      </header>
      <section className="settings-grid">
        <article className="panel">
          <h3>Profiles</h3>
          <p>No profiles configured.</p>
        </article>
        <article className="panel">
          <h3>Naming template</h3>
          <code>{"{yyyy}/{mm}/{slug}-{hash}.{ext}"}</code>
        </article>
      </section>
    </div>
  );
}
