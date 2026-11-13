import { R2Connect } from "@/features/storage/R2Connect";
import { t, useLocale, languages, getLanguagePreference, setLanguage, type LanguagePreference, type MessageKey } from "@/i18n";
import { ArrowUpRight, Cloud, Database, FileOutput, KeyRound, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { settingsApi } from "../../api/backend";
import type { AppSettings } from "../../api/backend";
import type { S3Profile } from "../../types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "../../lib/error";

interface SettingsPageProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  isActive?: boolean;
}

type SettingsSection = "general" | "storage" | "oauth" | "publishing";
const SECTIONS: Array<{ id: SettingsSection; label: MessageKey; icon: typeof Cloud }> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "storage", label: "S3 profiles", icon: Database },
  { id: "oauth", label: "Account authorization", icon: KeyRound },
  { id: "publishing", label: "Upload and naming", icon: FileOutput },
];

function upsertProfile(profiles: S3Profile[], profile: S3Profile): S3Profile[] {
  const index = profiles.findIndex((p) => p.id === profile.id);
  if (index === -1) {
    return [...profiles, profile];
  }
  const next = [...profiles];
  next[index] = profile;
  return next;
}

type ProfileField = "name" | "endpoint" | "region" | "bucket" | "accessKeyId" | "secretAccessKey" | "namingTemplate" | "publicBaseUrl" | "defaultPrefix";
type FieldErrors = Partial<Record<ProfileField, string>>;

function httpUrlError(value: string, label: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return t("{{label}} must use http: or https: protocol.", { label });
    if (!parsed.hostname) return t("{{label}} must include a host.", { label });
    if (parsed.username || parsed.password) return t("{{label}} must not include credentials.", { label });
    if (parsed.search || parsed.hash) return t("{{label}} must not contain query strings or fragments.", { label });
  } catch {
    return t("{{label}} is not a valid URL.", { label });
  }
}

export function SettingsPage({ settings, onSettingsChange, isActive = true }: SettingsPageProps) {
  useLocale();
  const [section, setSection] = useState<SettingsSection>("storage");
  const [editingProfileId, setEditingProfileId] = useState(
    settings.defaultProfileId ?? settings.profiles[0]?.id ?? "",
  );
  const [creatingNew, setCreatingNew] = useState(false);

  const profile = creatingNew ? undefined : settings.profiles.find((p) => p.id === editingProfileId);

  const [name, setName] = useState(profile?.name ?? "Personal S3");
  const [endpoint, setEndpoint] = useState(profile?.endpoint ?? "");
  const [region, setRegion] = useState(profile?.region ?? "auto");
  const [bucket, setBucket] = useState(profile?.bucket ?? "");
  const [accessKeyId, setAccessKeyId] = useState(profile?.accessKeyId ?? "");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [namingTemplate, setNamingTemplate] = useState(settings.namingTemplate);
  const [publicBaseUrl, setPublicBaseUrl] = useState(profile?.publicBaseUrl ?? "");
  const [defaultPrefix, setDefaultPrefix] = useState(profile?.defaultPrefix ?? "");
  const [pathStyle, setPathStyle] = useState(profile?.pathStyle ?? true);
  const [makeDefault, setMakeDefault] = useState(profile?.id === settings.defaultProfileId);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const fieldRefs = useRef<Partial<Record<ProfileField, HTMLInputElement>>>({});

  // Settings arrive after the initial render. If the selected profile did not
  // exist in the initial placeholder settings, select the loaded default.
  useEffect(() => {
    if (creatingNew || settings.profiles.some((p) => p.id === editingProfileId)) return;
    setEditingProfileId(settings.defaultProfileId ?? settings.profiles[0]?.id ?? "");
  }, [creatingNew, editingProfileId, settings.defaultProfileId, settings.profiles]);

  // Re-populate form fields when the selected profile changes OR when the
  // parent asynchronously delivers the real settings (App.tsx loads settings
  // after mount, so the initial render sees namingTemplate defaults).
  useEffect(() => {
    if (creatingNew) {
      // Clear form for new profile
      setName("");
      setEndpoint("");
      setRegion("auto");
      setBucket("");
      setAccessKeyId("");
      setSecretAccessKey("");
      setPublicBaseUrl("");
      setDefaultPrefix("");
      setPathStyle(true);
      setMakeDefault(settings.profiles.length === 0 && !settings.defaultProfileId);
      setFieldErrors({});
      return;
    }
    const p = settings.profiles.find((pr) => pr.id === editingProfileId);
    if (!p) return;
    setName(p.name);
    setEndpoint(p.endpoint);
    setRegion(p.region);
    setBucket(p.bucket);
    setAccessKeyId(p.accessKeyId);
    setSecretAccessKey("");
    setPublicBaseUrl(p.publicBaseUrl ?? "");
    setDefaultPrefix(p.defaultPrefix);
    setPathStyle(p.pathStyle ?? true);
    setMakeDefault(p.id === settings.defaultProfileId);
    setFieldErrors({});
  }, [editingProfileId, creatingNew, settings.defaultProfileId, settings.profiles]);

  // Sync naming template separately — it is app-level, not profile-level, and
  // arrives asynchronously after App's initial render with defaults.
  useEffect(() => {
    setNamingTemplate(settings.namingTemplate);
  }, [settings.namingTemplate]);

  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [connectingR2, setConnectingR2] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const connectionGenerationRef = useRef(0);

  useEffect(() => { if (!isActive) setConnectingR2(false); }, [isActive]);

  const changeSection = (next: SettingsSection) => {
    setConnectingR2(false);
    setSection(next);
  };

  const revealInvalidField = (field: ProfileField) => {
    setSection(["publicBaseUrl", "defaultPrefix", "namingTemplate"].includes(field) ? "publishing" : "storage");
    window.requestAnimationFrame(() => fieldRefs.current[field]?.focus());
  };

  useEffect(() => {
    connectionGenerationRef.current += 1;
    setConnectionMessage(null);
    setConnectionError(null);
  }, [name, endpoint, region, bucket, accessKeyId, secretAccessKey, pathStyle, publicBaseUrl, defaultPrefix, editingProfileId, creatingNew]);

  const validateProfileFields = (missingSecretMessage: string): FieldErrors => {
    const errors: FieldErrors = {};
    if (!name.trim()) errors.name = t("Profile name is required.");
    if (!endpoint.trim()) errors.endpoint = t("Endpoint is required.");
    else errors.endpoint = httpUrlError(endpoint, t("Endpoint"));
    if (!region.trim()) errors.region = t("Region is required.");
    if (!bucket.trim()) errors.bucket = t("Bucket is required.");
    if (!accessKeyId.trim()) errors.accessKeyId = t("Access key ID is required.");
    if (!secretAccessKey && !profile?.credentialRef) errors.secretAccessKey = missingSecretMessage;
    if (publicBaseUrl.trim()) errors.publicBaseUrl = httpUrlError(publicBaseUrl, t("Public Base URL"));
    if (defaultPrefix.split("/").some((segment) => segment === "." || segment === "..")) {
      errors.defaultPrefix = t("Default prefix must not contain path traversal segments.");
    } else if (Array.from(defaultPrefix).some((character) => /[\u0000-\u001f\u007f]/.test(character))) {
      errors.defaultPrefix = t("Default prefix must not contain control characters.");
    }
    return Object.fromEntries(Object.entries(errors).filter(([, value]) => value)) as FieldErrors;
  };

  const draftProfile = (id: string): S3Profile => ({
    id,
    name: name.trim(),
    endpoint: endpoint.trim(),
    region: region.trim(),
    bucket: bucket.trim(),
    accessKeyId: accessKeyId.trim(),
    credentialRef: profile?.credentialRef,
    pathStyle,
    publicBaseUrl: publicBaseUrl.trim() || undefined,
    defaultPrefix: defaultPrefix.trim().replace(/^\/+|\/+$/g, ""),
  });

  const handleTestConnection = async () => {
    const generation = ++connectionGenerationRef.current;
    setConnectionMessage(null);
    setConnectionError(null);
    const validationErrors = validateProfileFields(t("Enter a secret access key to test this new profile."));
    setFieldErrors(validationErrors);
    const firstInvalid = (Object.keys(validationErrors) as ProfileField[])[0];
    if (firstInvalid) {
      revealInvalidField(firstInvalid);
      return;
    }

    setTestingConnection(true);
    try {
      await settingsApi.testS3Connection({
        profile: draftProfile(profile?.id ?? crypto.randomUUID()),
        ...(secretAccessKey ? { secretAccessKey } : {}),
      });
      if (generation !== connectionGenerationRef.current) return;
      setConnectionMessage(t("Connection successful. Bucket listing works."));
    } catch (error) {
      if (generation !== connectionGenerationRef.current) return;
      setConnectionError(errorMessage(error, t("Connection test failed.")));
    } finally {
      setTestingConnection(false);
    }
  };

  const handleSaveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaveError(null);
    setSaveMessage(null);
    const errors = validateProfileFields(t("Secret access key is required for a new profile."));
    if (!namingTemplate.trim()) errors.namingTemplate = t("Naming template is required.");
    const validationErrors = errors;
    setFieldErrors(validationErrors);
    const firstInvalid = (Object.keys(validationErrors) as ProfileField[])[0];
    if (firstInvalid) {
      revealInvalidField(firstInvalid);
      return;
    }
    setSaving(true);

    try {
      const profileId = profile?.id || crypto.randomUUID();
      // Credential references are derived from the profile ID by the backend.
      // Persist the profile first so a failed settings write cannot orphan a
      // newly stored secret.
      const credentialRef = secretAccessKey ? `s3:${profileId}` : profile!.credentialRef!;

      const savedProfile: S3Profile = {
        ...draftProfile(profileId),
        credentialRef,
      };

      const nextSettings: AppSettings = {
        ...settings,
        profiles: upsertProfile(settings.profiles, savedProfile),
        namingTemplate: namingTemplate.trim(),
        defaultProfileId: makeDefault
          ? savedProfile.id
          : settings.defaultProfileId === savedProfile.id
            ? undefined
            : settings.defaultProfileId,
      };

      await settingsApi.saveSettings(nextSettings);
      try {
        if (secretAccessKey) {
          await settingsApi.saveS3Secret({
            profileId,
            secretAccessKey,
          });
        }
      } catch (error) {
        try {
          await settingsApi.saveSettings(settings);
        } catch (rollbackError) {
          setSaving(false);
          setSaveError(
            t("{{error}} The previous settings could not be restored: {{rollback}}", { error: errorMessage(error, t("Failed to save profile.")), rollback: errorMessage(rollbackError, t("Unknown error.")) }),
          );
          return;
        }
        throw error;
      }
      onSettingsChange(nextSettings);
      setSecretAccessKey("");
      setSaving(false);
      setSaveMessage(t("Profile saved."));
      setCreatingNew(false);
      setEditingProfileId(profileId);
    } catch (error) {
      setSaving(false);
      setSaveError(errorMessage(error, t("Failed to save profile.")));
    }
  };

  const fieldProps = (field: ProfileField) => ({
    ref: (element: HTMLInputElement | null) => { if (element) fieldRefs.current[field] = element; },
    "aria-invalid": Boolean(fieldErrors[field]),
    "aria-describedby": fieldErrors[field] ? `${field}-error` : undefined,
  });

  const renderFieldError = (field: ProfileField) => fieldErrors[field]
    ? <span id={`${field}-error`} className="field-error">{fieldErrors[field]}</span>
    : null;

  const handleSectionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const index = tabs.indexOf(event.currentTarget);
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
    tabs[next]?.click();
  };

  const inputField = (field: ProfileField, label: MessageKey, value: string, update: (value: string) => void, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <Label className="field">
      <span>{t(label)}</span>
      <Input {...fieldProps(field)} {...extra} value={value} onChange={(event) => update(event.target.value)} />
      {renderFieldError(field)}
    </Label>
  );

  return (
    <div className="page settings-page">
      <aside className="settings-sidebar">
        <h2>{t("Settings")}</h2>
        <nav role="tablist" aria-label={t("Settings categories")} aria-orientation="vertical">
          {SECTIONS.map(({ id, label, icon: Icon }) => <Button key={id} id={`settings-tab-${id}`} type="button" variant="ghost" role="tab" aria-selected={section === id} aria-controls={id === "storage" || id === "publishing" ? "settings-section-profile" : `settings-section-${id}`} tabIndex={section === id ? 0 : -1} disabled={saving || testingConnection} onClick={() => changeSection(id)} onKeyDown={handleSectionKeyDown}>
            <Icon className="size-4" aria-hidden="true" />{t(label)}
          </Button>)}
        </nav>
      </aside>
      <div className="settings-content">
        <section id="settings-section-general" role="tabpanel" aria-labelledby="settings-tab-general" hidden={section !== "general"}>
          <h2 className="settings-title">{t("General")}</h2>
          <Label className="settings-language field">
            <span>{t("Language")}</span>
            <NativeSelect aria-label={t("Language")} value={getLanguagePreference()} onChange={(event) => setLanguage(event.target.value as LanguagePreference)}>
              <NativeSelectOption value="system">{t("System default")}</NativeSelectOption>
              {languages.map(({ id, label }) => <NativeSelectOption key={id} value={id}>{label}</NativeSelectOption>)}
            </NativeSelect>
          </Label>
          <p className="field-hint">{t("Language changes apply immediately and are saved on this device.")}</p>
        </section>
        <section id="settings-section-oauth" role="tabpanel" aria-labelledby="settings-tab-oauth" hidden={section !== "oauth"}>
          <h2 className="settings-title">{t("Account authorization")}</h2>
          {section === "oauth" && isActive && <R2Connect onConnected={onSettingsChange} onBusyChange={setConnectingR2} disabled={saving || testingConnection} />}
        </section>
        <form id="settings-section-profile" role="tabpanel" aria-labelledby={`settings-tab-${section === "publishing" ? "publishing" : "storage"}`} className="settings-sheet" hidden={section !== "storage" && section !== "publishing"} onSubmit={handleSaveProfile}>
          <fieldset className="settings-fields" disabled={saving || connectingR2}>
            <section hidden={section !== "storage"}>
              <h2 className="settings-title">{t("S3 profiles")}</h2>
              <div className="storage-hero">
                <div><h3>{t("Add R2 with your Cloudflare account")}</h3><p>{t("Authorize in your browser, then choose buckets to create profiles.")}</p></div>
                <Button type="button" onClick={() => changeSection("oauth")}>{t("Add with an account")}<ArrowUpRight className="size-4" aria-hidden="true" /></Button>
              </div>
            </section>
            <section hidden={section !== "publishing"}>
              <h2 className="settings-title">{t("Upload and naming")}</h2>
            </section>
            <div className="settings-scope">
              {settings.profiles.length > 1 && <Label className="field"><span>{t("Editing profile")}</span><NativeSelect value={creatingNew ? "new" : editingProfileId} onChange={(event) => { setCreatingNew(false); setEditingProfileId(event.target.value); }}>
                {creatingNew && <NativeSelectOption value="new">{t("Add profile")}</NativeSelectOption>}
                {settings.profiles.map((entry) => <NativeSelectOption key={entry.id} value={entry.id}>{entry.name}</NativeSelectOption>)}
              </NativeSelect></Label>}
              <Button variant="ghost" type="button" aria-label={t("Add profile")} onClick={() => { setCreatingNew(true); changeSection("storage"); }}>{t("Add manually")}</Button>
            </div>
            <div hidden={section !== "storage"}>
              <section className="settings-group">
                <h3>{t("Connection")}</h3>
                <div className="field-grid">
                  {inputField("name", "Profile name", name, setName)}
                  {inputField("bucket", "Bucket", bucket, setBucket, { placeholder: "my-image-bucket" })}
                  <div className="field-full">{inputField("endpoint", "Endpoint", endpoint, setEndpoint, { placeholder: "https://s3.example.com" })}</div>
                  {inputField("region", "Region", region, setRegion)}
                  <Label className="field-switch"><span>{t("Path style addressing")}<small>{t("Use bucket-in-path requests when your provider requires them.")}</small></span><Switch aria-label={t("Path style addressing")} checked={pathStyle} onCheckedChange={setPathStyle} /></Label>
                </div>
              </section>
              <section className="settings-group">
                <h3>{t("Credentials")}</h3>
                <div className="field-grid">
                  {inputField("accessKeyId", "Access key ID", accessKeyId, setAccessKeyId, { autoComplete: "off" })}
                  {inputField("secretAccessKey", "Secret access key", secretAccessKey, setSecretAccessKey, { type: "password", autoComplete: "off" })}
                </div>
                <p className="field-hint">{t("Credentials are stored locally on this device as private files with restricted permissions. Not synced or encrypted.")}</p>
              </section>
            </div>
            <div hidden={section !== "publishing"}>
              <section className="settings-group">
                <div className="field-grid">
                  <div className="field-full">{inputField("publicBaseUrl", "Public Base URL", publicBaseUrl, setPublicBaseUrl, { placeholder: "https://cdn.example.com" })}</div>
                  <div className="field-full">{inputField("defaultPrefix", "Default prefix", defaultPrefix, setDefaultPrefix, { placeholder: "images/2026/06" })}</div>
                </div>
              </section>
              <section className="settings-group">
                <p className="settings-scope-note">{t("Applies to all profiles")}</p>
                {inputField("namingTemplate", "Naming template", namingTemplate, setNamingTemplate)}
              </section>
              <section className="settings-group">
                <Label className="field-switch"><span>{t("Use as default profile")}<small>{t("New compressions upload here unless you choose another profile.")}</small></span><Switch aria-label={t("Use as default profile")} checked={makeDefault} onCheckedChange={setMakeDefault} /></Label>
              </section>
            </div>
            <footer className="settings-actions">
              {section === "storage" && <Button variant="outline" type="button" onClick={handleTestConnection} disabled={testingConnection || saving}>{testingConnection ? t("Testing...") : t("Test connection")}</Button>}
              <Button type="submit" disabled={saving || testingConnection}>{t("Save profile")}</Button>
            </footer>
            {(saving || saveMessage || connectionMessage || connectionError || saveError) && <div className="settings-status">
              {saving && <p role="status">{t("Saving profile...")}</p>}
              {saveMessage && <p role="status">{saveMessage}</p>}
              {connectionMessage && <p role="status">{connectionMessage}</p>}
              {connectionError && <Alert variant="destructive"><AlertDescription>{connectionError}</AlertDescription></Alert>}
              {saveError && <Alert variant="destructive"><AlertDescription>{saveError}</AlertDescription></Alert>}
            </div>}
          </fieldset>
        </form>
      </div>
    </div>
  );
}
