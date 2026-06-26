import { useCallback, useEffect, useRef, useState } from "react";
import { settingsApi } from "../../api/tauri";
import type { AppSettings } from "../../api/tauri";
import type { CompressionPreset, ImageFormat, S3Profile } from "../../types";
import { AlertDialog } from "../../components/AlertDialog";

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

const EMPTY_PRESET: Omit<CompressionPreset, "id"> = {
  name: "",
  targetFormat: "webp",
  quality: 85,
  removeGps: true,
};

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

  // Preset management state
  const [editingPreset, setEditingPreset] = useState<CompressionPreset | null>(null);
  const [isAddingPreset, setIsAddingPreset] = useState(false);
  const [presetForm, setPresetForm] = useState<Omit<CompressionPreset, "id">>({ ...EMPTY_PRESET });

  const [deleteTarget, setDeleteTarget] = useState<CompressionPreset | null>(null);
  const presetDialogRef = useRef<HTMLDivElement>(null);

  const isPresetDialogOpen = isAddingPreset || editingPreset !== null;

  const closePresetDialog = useCallback(() => {
    setEditingPreset(null);
    setIsAddingPreset(false);
    setPresetForm({ ...EMPTY_PRESET });
  }, []);

  // Escape key closes the preset dialog
  useEffect(() => {
    if (!isPresetDialogOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePresetDialog();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isPresetDialogOpen, closePresetDialog]);

  // Focus trap for preset dialog
  useEffect(() => {
    if (!isPresetDialogOpen || !presetDialogRef.current) return;
    const dialog = presetDialogRef.current;
    dialog.focus();
  }, [isPresetDialogOpen]);

  const openAddPreset = () => {
    setEditingPreset(null);
    setIsAddingPreset(true);
    setPresetForm({ ...EMPTY_PRESET });
  };

  const openEditPreset = (preset: CompressionPreset) => {
    setEditingPreset(preset);
    setIsAddingPreset(false);
    setPresetForm({
      name: preset.name,
      targetFormat: preset.targetFormat,
      quality: preset.quality,
      removeGps: preset.removeGps,
    });
  };

  const handleSavePreset = async () => {
    if (!presetForm.name.trim()) return;

    const updatedPreset: CompressionPreset = editingPreset
      ? { ...editingPreset, ...presetForm }
      : { id: crypto.randomUUID(), ...presetForm };

    const updatedPresets = editingPreset
      ? settings.presets.map((p) => (p.id === editingPreset.id ? updatedPreset : p))
      : [...settings.presets, updatedPreset];

    const nextSettings: AppSettings = { ...settings, presets: updatedPresets };
    await settingsApi.saveSettings(nextSettings);
    onSettingsChange(nextSettings);
    closePresetDialog();
  };

  const handleDeletePresetRequest = (preset: CompressionPreset) => {
    setDeleteTarget(preset);
  };

  const handleDeletePresetConfirm = async () => {
    if (!deleteTarget) return;
    const nextSettings: AppSettings = {
      ...settings,
      presets: settings.presets.filter((p) => p.id !== deleteTarget.id),
    };
    await settingsApi.saveSettings(nextSettings);
    onSettingsChange(nextSettings);
    if (editingPreset?.id === deleteTarget.id) {
      setEditingPreset(null);
      setIsAddingPreset(false);
      setPresetForm({ ...EMPTY_PRESET });
    }
    setDeleteTarget(null);
  };

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
            <button className="btn-primary" type="submit" disabled={saving}>Save profile</button>
          </form>
          {saving && <p className="status-line">Saving profile...</p>}
          {saveMessage && <p className="success-text" role="status">{saveMessage}</p>}
          {saveError && <p className="error-text" role="alert">{saveError}</p>}
          {allowInsecureFallback && (
            <p className="error-text">Warning: Credential fallback to local storage is enabled. Secrets may be stored insecurely.</p>
          )}
          <p>Secrets use system secure storage when available. Local fallback must be explicitly allowed.</p>
        </article>

        <article className="panel">
          <div className="panel-header">
            <h3>Presets</h3>
            <button className="btn-primary" type="button" onClick={openAddPreset}>Add preset</button>
          </div>
          {settings.presets.length === 0 && (
            <p className="status-line">No presets configured.</p>
          )}
          {settings.presets.length > 0 && (
            <ul className="preset-list">
              {settings.presets.map((preset) => (
                <li key={preset.id} className="preset-item">
                  <span>
                    {preset.name} ({preset.targetFormat.toUpperCase()} {preset.quality}%)
                  </span>
                  <div className="preset-item-actions">
                    <button className="btn-secondary btn-sm" type="button" onClick={() => openEditPreset(preset)}>Edit</button>
                    <button className="btn-danger btn-sm" type="button" onClick={() => handleDeletePresetRequest(preset)}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      {isPresetDialogOpen && (
        <div className="modal-backdrop" onClick={closePresetDialog}>
          <section
            ref={presetDialogRef}
            className="modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="preset-dialog-title"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="preset-dialog-title">{editingPreset ? "Edit preset" : "Add preset"}</h3>
              <button className="btn-secondary btn-sm" type="button" onClick={closePresetDialog}>Close</button>
            </div>
            <form
              className="profile-form preset-dialog-form"
              onSubmit={(e) => { e.preventDefault(); handleSavePreset(); }}
            >
              <label>
                Preset name
                <input
                  value={presetForm.name}
                  onChange={(e) => setPresetForm((f) => ({ ...f, name: e.target.value }))}
                  required
                />
              </label>
              <label>
                Target format
                <select
                  value={presetForm.targetFormat}
                  onChange={(e) => setPresetForm((f) => ({ ...f, targetFormat: e.target.value as ImageFormat }))}
                >
                  <option value="jpg">JPG</option>
                  <option value="png">PNG</option>
                  <option value="webp">WebP</option>
                  <option value="avif">AVIF</option>
                  <option value="heif">HEIF</option>
                </select>
              </label>
              <label>
                Quality (1-100)
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={presetForm.quality}
                  onChange={(e) => setPresetForm((f) => ({ ...f, quality: Number(e.target.value) }))}
                />
              </label>
              <label>
                Remove GPS
                <input
                  type="checkbox"
                  checked={presetForm.removeGps}
                  onChange={(e) => setPresetForm((f) => ({ ...f, removeGps: e.target.checked }))}
                />
              </label>
              <div className="preset-form-actions">
                <button className="btn-primary" type="submit">{editingPreset ? "Update preset" : "Save preset"}</button>
                <button className="btn-secondary" type="button" onClick={closePresetDialog}>Cancel</button>
              </div>
            </form>
          </section>
        </div>
      )}
      <AlertDialog
        open={deleteTarget !== null}
        title={`Delete preset "${deleteTarget?.name ?? ""}"?`}
        description="This preset will be permanently removed. This action cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={handleDeletePresetConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
