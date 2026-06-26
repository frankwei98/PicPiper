import { useState } from "react";
import { settingsApi } from "../../api/tauri";
import type { AppSettings } from "../../api/tauri";
import type { S3Profile } from "../../types";

interface SettingsPageProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

function upsertProfile(profiles: S3Profile[], profile: S3Profile): S3Profile[] {
  const index = profiles.findIndex((p) => p.id === profile.id);
  if (index === -1) {
    return [...profiles, profile];
  }
  const next = [...profiles];
  next[index] = profile;
  return next;
}

export function SettingsPage({ settings, onSettingsChange }: SettingsPageProps) {
  const profile = settings.profiles[0];

  const [name, setName] = useState(profile?.name ?? "Personal S3");
  const [endpoint, setEndpoint] = useState(profile?.endpoint ?? "");
  const [region, setRegion] = useState(profile?.region ?? "auto");
  const [bucket, setBucket] = useState(profile?.bucket ?? "");
  const [accessKeyId, setAccessKeyId] = useState(profile?.accessKeyId ?? "");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [allowInsecureFallback, setAllowInsecureFallback] = useState(
    profile?.insecureSecretFallback ?? false,
  );
  const [namingTemplate, setNamingTemplate] = useState(settings.namingTemplate);
  const [publicBaseUrl, setPublicBaseUrl] = useState(profile?.publicBaseUrl ?? "");
  const [defaultPrefix, setDefaultPrefix] = useState(profile?.defaultPrefix ?? "");
  const [pathStyle] = useState(profile?.pathStyle ?? true);

  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSaveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaveError(null);
    setSaveMessage(null);
    setSaving(true);

    try {
      if (!secretAccessKey && !profile?.credentialRef) {
        setSaving(false);
        setSaveError("Secret access key is required for a new profile.");
        return;
      }

      const profileId = profile?.id || crypto.randomUUID();

      const secretResult = secretAccessKey
        ? await settingsApi.saveS3Secret({
            profileId,
            secretAccessKey,
            allowInsecureFallback,
          })
        : {
            credentialRef: profile!.credentialRef!,
            insecureFallbackUsed: profile!.insecureSecretFallback ?? false,
          };

      const savedProfile: S3Profile = {
        id: profileId,
        name,
        endpoint,
        region,
        bucket,
        accessKeyId,
        credentialRef: secretResult.credentialRef,
        pathStyle,
        publicBaseUrl: publicBaseUrl || undefined,
        defaultPrefix,
        insecureSecretFallback: secretResult.insecureFallbackUsed,
      };

      const nextSettings: AppSettings = {
        ...settings,
        profiles: upsertProfile(settings.profiles, savedProfile),
        namingTemplate,
        defaultProfileId: savedProfile.id,
      };

      await settingsApi.saveSettings(nextSettings);
      onSettingsChange(nextSettings);
      setSecretAccessKey("");
      setSaving(false);
      setSaveMessage("Profile saved.");
    } catch (error) {
      setSaving(false);
      setSaveError(error instanceof Error ? error.message : String(error));
    }
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
          <form className="profile-form" onSubmit={handleSaveProfile}>
            <label>
              Profile name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Endpoint
              <input
                placeholder="https://s3.example.com"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </label>
            <label>
              Region
              <input
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              />
            </label>
            <label>
              Bucket
              <input
                placeholder="my-image-bucket"
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
              />
            </label>
            <label>
              Access key ID
              <input
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
              />
            </label>
            <label>
              Secret access key
              <input
                type="password"
                value={secretAccessKey}
                onChange={(e) => setSecretAccessKey(e.target.value)}
              />
            </label>
            <label>
              Allow local secret fallback
              <input
                type="checkbox"
                checked={allowInsecureFallback}
                onChange={(e) => setAllowInsecureFallback(e.target.checked)}
              />
            </label>
            <label>
              Naming template
              <input
                value={namingTemplate}
                onChange={(e) => setNamingTemplate(e.target.value)}
              />
            </label>
            <label>
              Public Base URL
              <input
                placeholder="https://cdn.example.com"
                value={publicBaseUrl}
                onChange={(e) => setPublicBaseUrl(e.target.value)}
              />
            </label>
            <label>
              Default prefix
              <input
                placeholder="images/2026/06"
                value={defaultPrefix}
                onChange={(e) => setDefaultPrefix(e.target.value)}
              />
            </label>
            <button type="submit" disabled={saving}>Save profile</button>
          </form>
          {saving && <p className="status-line">Saving profile...</p>}
          {saveMessage && <p className="success-text" role="status">{saveMessage}</p>}
          {saveError && <p className="error-text" role="alert">{saveError}</p>}
          {allowInsecureFallback && (
            <p className="error-text">Warning: Credential fallback to local storage is enabled. Secrets may be stored insecurely.</p>
          )}
          <p>Secrets use system secure storage when available. Local fallback must be explicitly allowed.</p>
        </article>
      </section>
    </div>
  );
}
