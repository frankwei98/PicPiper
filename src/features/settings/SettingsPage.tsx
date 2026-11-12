import { t, useLocale, languages, getLanguagePreference, setLanguage, type LanguagePreference } from "@/i18n";
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

export function SettingsPage({ settings, onSettingsChange }: SettingsPageProps) {
  useLocale();
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
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const connectionGenerationRef = useRef(0);

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
      fieldRefs.current[firstInvalid]?.focus();
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
      fieldRefs.current[firstInvalid]?.focus();
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

  return (
    <div className="page settings-page">
      <header className="page-head">
        <div>
          <h2 className="page-title">{t("Settings")}</h2>
          <p className="page-note">{t("Manage S3 profiles, naming, and output defaults.")}</p>
        </div>
      </header>
      <section className="settings-sheet">
        <div className="settings-group">
          <div className="settings-group-head">
            <h3>{t("Language")}</h3>
            <p>{t("Language changes apply immediately and are saved on this device.")}</p>
          </div>
          <div className="field-grid">
            <Label className="field">
              <span>{t("Language")}</span>
              <NativeSelect aria-label={t("Language")} value={getLanguagePreference()} onChange={(event) => setLanguage(event.target.value as LanguagePreference)}>
                <NativeSelectOption value="system">{t("System default")}</NativeSelectOption>
                {languages.map(({ id, label }) => <NativeSelectOption key={id} value={id}>{label}</NativeSelectOption>)}
              </NativeSelect>
            </Label>
          </div>
        </div>
      </section>
      <form className="settings-sheet" onSubmit={handleSaveProfile}>
        {settings.profiles.length > 1 && (
          <div className="settings-scope">
            <Label>
              {t("Editing profile")}
              <NativeSelect
                value={editingProfileId}
                onChange={(e) => setEditingProfileId(e.target.value)}
              >
                {settings.profiles.map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>{p.name}</NativeSelectOption>
                ))}
              </NativeSelect>
            </Label>
          </div>
        )}

        <section className="settings-group">
          <div className="settings-group-head">
            <h3>{t("Connection")}</h3>
            <p>{t("The endpoint, region, and bucket that Pic Piper signs requests against.")}</p>
          </div>
          <div className="field-grid">
            <Label className="field">
              <span>{t("Profile name")}</span>
              <Input {...fieldProps("name")} value={name} onChange={(e) => setName(e.target.value)} />
              {renderFieldError("name")}
            </Label>
            <Label className="field">
              <span>{t("Endpoint")}</span>
              <Input {...fieldProps("endpoint")} placeholder="https://s3.example.com" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
              {renderFieldError("endpoint")}
            </Label>
            <Label className="field">
              <span>{t("Region")}</span>
              <Input {...fieldProps("region")} value={region} onChange={(e) => setRegion(e.target.value)} />
              {renderFieldError("region")}
            </Label>
            <Label className="field">
              <span>{t("Bucket")}</span>
              <Input {...fieldProps("bucket")} placeholder="my-image-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} />
              {renderFieldError("bucket")}
            </Label>
          </div>
        </section>

        <section className="settings-group">
          <div className="settings-group-head">
            <h3>{t("Credentials")}</h3>
            <p>{t("Credentials are stored locally on this device as private files with restricted permissions. Not synced or encrypted.")}</p>
          </div>
          <div className="field-grid">
            <Label className="field">
              <span>{t("Access key ID")}</span>
              <Input {...fieldProps("accessKeyId")} value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
              {renderFieldError("accessKeyId")}
            </Label>
            <Label className="field">
              <span>{t("Secret access key")}</span>
              <Input {...fieldProps("secretAccessKey")} type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} />
              {renderFieldError("secretAccessKey")}
            </Label>
            <Label className="field-switch">
              <span>{t("Path style addressing")}<small>{t("Use bucket-in-path requests when your provider requires them.")}</small></span>
              <Switch aria-label={t("Path style addressing")} checked={pathStyle} onCheckedChange={setPathStyle} />
            </Label>
            <Label className="field-switch">
              <span>{t("Use as default profile")}<small>{t("New compressions upload here unless you choose another profile.")}</small></span>
              <Switch aria-label={t("Use as default profile")} checked={makeDefault} onCheckedChange={setMakeDefault} />
            </Label>
          </div>
        </section>

        <section className="settings-group">
          <div className="settings-group-head">
            <h3>{t("Publishing")}</h3>
            <p>{t("How object keys are built and where public links point.")}</p>
          </div>
          <div className="field-grid">
            <Label className="field">
              <span>{t("Naming template")}</span>
              <Input {...fieldProps("namingTemplate")} value={namingTemplate} onChange={(e) => setNamingTemplate(e.target.value)} />
              {renderFieldError("namingTemplate")}
            </Label>
            <Label className="field">
              <span>{t("Public Base URL")}</span>
              <Input {...fieldProps("publicBaseUrl")} placeholder="https://cdn.example.com" value={publicBaseUrl} onChange={(e) => setPublicBaseUrl(e.target.value)} />
              {renderFieldError("publicBaseUrl")}
            </Label>
            <Label className="field">
              <span>{t("Default prefix")}</span>
              <Input {...fieldProps("defaultPrefix")} placeholder="images/2026/06" value={defaultPrefix} onChange={(e) => setDefaultPrefix(e.target.value)} />
              {renderFieldError("defaultPrefix")}
            </Label>
          </div>
        </section>

        <footer className="settings-actions">
          <Button type="submit" disabled={saving}>{t("Save profile")}</Button>
          <Button variant="outline" type="button" onClick={handleTestConnection} disabled={testingConnection || saving}>
            {testingConnection ? t("Testing...") : t("Test connection")}
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => setCreatingNew(true)}
          >
            {t("Add profile")}
          </Button>
        </footer>

        {(saving || saveMessage || connectionMessage || connectionError || saveError) && (
          <div className="settings-status">
            {saving && <p>{t("Saving profile...")}</p>}
            {saveMessage && <p>{saveMessage}</p>}
            {connectionMessage && <p role="status">{connectionMessage}</p>}
            {connectionError && (
              <Alert variant="destructive"><AlertDescription>{connectionError}</AlertDescription></Alert>
            )}
            {saveError && (
              <Alert variant="destructive">
                <AlertDescription>{saveError}</AlertDescription>
              </Alert>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
