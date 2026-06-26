import { useState } from "react";
import { settingsApi } from "../../api/tauri";
import type { AppSettings } from "../../api/tauri";
import type { S3Profile } from "../../types";
import { StatusMessage } from "../../components/ui/Toast";
import { cn } from "../../utils/cn";

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

const btnBase = "border-none rounded-md cursor-pointer text-callout font-medium px-5 py-2.5 transition-[background-color,box-shadow,filter] duration-150 ease-out inline-flex items-center justify-center gap-sm leading-none focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-38 disabled:cursor-not-allowed disabled:pointer-events-none";
const btnPrimary = cn(btnBase, "bg-primary-container text-on-primary-container font-semibold hover:shadow-[0_1px_3px_rgba(0,0,0,0.3)] hover:brightness-110");

const inputClass = "rounded-md border border-outline-variant bg-surface-container text-on-surface p-2.5 text-body transition-[border-color,box-shadow] duration-150 ease-out focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 w-full";
const labelClass = "grid gap-xs text-footnote font-medium text-on-surface-variant";

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
    <div className="grid gap-lg max-w-page">
      <header className="flex justify-between items-start gap-lg">
        <div>
          <h2 className="text-large-title font-bold text-on-surface text-balance">Settings</h2>
          <p className="text-on-surface-variant mt-xs text-body text-pretty">Manage S3 profiles, naming, and output defaults.</p>
        </div>
      </header>
      <section className="grid gap-lg max-w-[980px]">
        <article className="border border-outline-variant rounded-lg bg-surface-container p-lg transition-[border-color] duration-200 hover:border-outline">
          <h3 className="text-title-2 font-semibold text-on-surface text-balance mb-md">Profile</h3>
          <form className="grid gap-md grid-cols-2 max-lg:grid-cols-1" onSubmit={handleSaveProfile}>
            <label className={labelClass}>
              Profile name
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className={labelClass}>
              Endpoint
              <input className={inputClass} placeholder="https://s3.example.com" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
            </label>
            <label className={labelClass}>
              Region
              <input className={inputClass} value={region} onChange={(e) => setRegion(e.target.value)} />
            </label>
            <label className={labelClass}>
              Bucket
              <input className={inputClass} placeholder="my-image-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} />
            </label>
            <label className={labelClass}>
              Access key ID
              <input className={inputClass} value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
            </label>
            <label className={labelClass}>
              Secret access key
              <input className={inputClass} type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} />
            </label>
            <label className={labelClass}>
              Allow local secret fallback
              <input
                type="checkbox"
                checked={allowInsecureFallback}
                onChange={(e) => setAllowInsecureFallback(e.target.checked)}
              />
            </label>
            <label className={labelClass}>
              Naming template
              <input className={inputClass} value={namingTemplate} onChange={(e) => setNamingTemplate(e.target.value)} />
            </label>
            <label className={labelClass}>
              Public Base URL
              <input className={inputClass} placeholder="https://cdn.example.com" value={publicBaseUrl} onChange={(e) => setPublicBaseUrl(e.target.value)} />
            </label>
            <label className={labelClass}>
              Default prefix
              <input className={inputClass} placeholder="images/2026/06" value={defaultPrefix} onChange={(e) => setDefaultPrefix(e.target.value)} />
            </label>
            <button className={btnPrimary} type="submit" disabled={saving}>Save profile</button>
          </form>
          {saving && <StatusMessage>Saving profile...</StatusMessage>}
          {saveMessage && <StatusMessage>{saveMessage}</StatusMessage>}
          {saveError && <StatusMessage variant="error">{saveError}</StatusMessage>}
          {allowInsecureFallback && (
            <StatusMessage variant="error">Warning: Credential fallback to local storage is enabled. Secrets may be stored insecurely.</StatusMessage>
          )}
          <p className="text-on-surface-variant text-footnote text-pretty">Secrets use system secure storage when available. Local fallback must be explicitly allowed.</p>
        </article>
      </section>
    </div>
  );
}
