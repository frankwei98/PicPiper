import type { AppSettings } from "../../api/tauri";

interface SettingsPageProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

export function SettingsPage({ settings, onSettingsChange }: SettingsPageProps) {
  const handleSaveProfile = () => {
    onSettingsChange(settings);
  };

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
          <h3>Profile</h3>
          <form className="profile-form">
            <label>
              Profile name
              <input defaultValue="Personal S3" />
            </label>
            <label>
              Endpoint
              <input placeholder="https://s3.example.com" />
            </label>
            <label>
              Region
              <input defaultValue="auto" />
            </label>
            <label>
              Bucket
              <input placeholder="my-image-bucket" />
            </label>
            <label>
              Access key ID
              <input />
            </label>
            <label>
              Secret access key
              <input type="password" />
            </label>
            <label>
              Allow local secret fallback
              <input type="checkbox" />
            </label>
            <label>
              Naming template
              <input defaultValue="{yyyy}/{mm}/{slug}-{hash}.{ext}" />
            </label>
            <label>
              Public Base URL
              <input placeholder="https://cdn.example.com" />
            </label>
            <label>
              Default prefix
              <input placeholder="images/2026/06" />
            </label>
            <button type="button" onClick={handleSaveProfile}>Save profile</button>
          </form>
          <p>Secrets use system secure storage when available. Local fallback must be explicitly allowed.</p>
        </article>
      </section>
    </div>
  );
}
