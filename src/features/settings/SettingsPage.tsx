import { R2Connect } from "@/features/storage/R2Connect";
import { t, useLocale, languages, getLanguagePreference, setLanguage, type LanguagePreference, type MessageKey } from "@/i18n";
import { ArrowUpRight, Cloud, Database, FileOutput, KeyRound, Settings2 } from "lucide-react";
import { Tabs } from "@base-ui/react/tabs";
import { useEffect, useRef, useState } from "react";
import { settingsApi } from "../../api/backend";
import { defaultMiniSettings, type AppSettings, type MiniSettings, type ProcessingLimits } from "../../api/backend";
import type { S3Profile } from "../../types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "../../lib/error";
import { MiniPreferences, miniSettingsValid } from "@/features/mini/MiniPreferences";
import { PreferenceRow } from "@/components/ui/preference-row";
import { UpdatePreferences } from "./UpdatePreferences";

interface SettingsPageProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  isActive?: boolean;
  processingLimits?: ProcessingLimits;
}

type SettingsSection = "general" | "storage" | "oauth" | "publishing";
const SECTION_GROUPS: Array<{ label: MessageKey; items: Array<{ id: SettingsSection; label: MessageKey; icon: typeof Cloud }> }> = [
  { label: "Application", items: [{ id: "general", label: "General", icon: Settings2 }] },
  { label: "Cloud storage", items: [
    { id: "storage", label: "S3 profiles", icon: Database },
    { id: "oauth", label: "One-click authorization", icon: KeyRound },
    { id: "publishing", label: "Links and naming", icon: FileOutput },
  ] },
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

export function SettingsPage({ settings, onSettingsChange, isActive = true, processingLimits }: SettingsPageProps) {
  useLocale();
  const [section, setSection] = useState<SettingsSection>("general");
  const [mini, setMini] = useState<MiniSettings>({ ...(settings.mini ?? defaultMiniSettings), action: "clipboard" });
  const [closeBehavior, setCloseBehavior] = useState<AppSettings["closeBehavior"]>(settings.closeBehavior ?? "quit");
  const [processingConcurrency, setProcessingConcurrency] = useState(settings.processingConcurrency ?? 0);
  const cpuCount = Math.max(1, processingLimits?.cpuCount ?? navigator.hardwareConcurrency ?? 4);
  const defaultConcurrency = Math.min(cpuCount, Math.max(1, processingLimits?.defaultConcurrency ?? Math.ceil(cpuCount * 0.5)));
  const [generalSaving, setGeneralSaving] = useState(false);
  const [generalMessage, setGeneralMessage] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [editingProfileId, setEditingProfileId] = useState(
    settings.defaultProfileId ?? settings.profiles[0]?.id ?? "",
  );
  const [creatingNew, setCreatingNew] = useState(false);

  useEffect(() => {
    setMini({ ...(settings.mini ?? defaultMiniSettings), action: "clipboard" });
  }, [settings.mini]);
  useEffect(() => {
    setCloseBehavior(settings.closeBehavior ?? "quit");
  }, [settings.closeBehavior]);
  useEffect(() => {
    setProcessingConcurrency(settings.processingConcurrency ?? 0);
  }, [settings.processingConcurrency]);

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
  const [providerBusy, setProviderBusy] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const connectionGenerationRef = useRef(0);

  useEffect(() => { if (!isActive) setProviderBusy(false); }, [isActive]);

  const changeSection = (next: SettingsSection) => {
    setProviderBusy(false);
    setSection(next);
  };

  const handleSaveGeneral = async (event: React.FormEvent) => {
    event.preventDefault();
    setGeneralMessage(null);
    setGeneralError(null);
    if (!miniSettingsValid(mini, settings.profiles)) {
      setGeneralError(t("Failed to save general settings."));
      return;
    }
    setGeneralSaving(true);
    const nextSettings = { ...settings, mini, closeBehavior, processingConcurrency };
    try {
      await settingsApi.saveSettings(nextSettings);
      onSettingsChange(nextSettings);
      setGeneralMessage(t("General settings saved."));
    } catch (error) {
      setGeneralError(errorMessage(error, t("Failed to save general settings.")));
    } finally {
      setGeneralSaving(false);
    }
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

  const inputField = (field: ProfileField, label: MessageKey, value: string, update: (value: string) => void, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <Label className="field">
      <span>{t(label)}</span>
      <Input {...fieldProps(field)} {...extra} value={value} onChange={(event) => update(event.target.value)} />
      {renderFieldError(field)}
    </Label>
  );

  return (
    <Tabs.Root className="page settings-page" value={section} orientation="vertical" onValueChange={(value: SettingsSection) => changeSection(value)}>
      <aside className="settings-sidebar">
        <h2>{t("Settings")}</h2>
        <Tabs.List className="settings-navigation" aria-label={t("Settings categories")} activateOnFocus>
          {SECTION_GROUPS.map((group) => <div key={group.label} className="settings-nav-group">
            <h3>{t(group.label)}</h3>
            {group.items.map(({ id, label, icon: Icon }) => <Tabs.Tab key={id} value={id} id={`settings-tab-${id}`} className={cn(buttonVariants({ variant: "ghost" }))} disabled={saving || testingConnection || generalSaving}>
              <Icon className="size-4" aria-hidden="true" />{t(label)}
            </Tabs.Tab>)}
          </div>)}
        </Tabs.List>
      </aside>
      <div className="settings-content">
        <Tabs.Panel value="general" id="settings-section-general" keepMounted render={<form className="settings-sheet settings-general" onSubmit={handleSaveGeneral} />}>
          <fieldset className="settings-fields" disabled={generalSaving}>
            <h2 className="settings-title">{t("General")}</h2>
            <section className="settings-group settings-preferences">
              <h3>{t("Preferences")}</h3>
              <PreferenceRow label={t("Language")} htmlFor="settings-language" description={t("Language changes apply immediately and are saved on this device.")} descriptionId="settings-language-description">
                <NativeSelect id="settings-language" aria-label={t("Language")} aria-describedby="settings-language-description" value={getLanguagePreference()} onChange={(event) => setLanguage(event.target.value as LanguagePreference)}>
                  <NativeSelectOption value="system">{t("System default")}</NativeSelectOption>
                  {languages.map(({ id, label }) => <NativeSelectOption key={id} value={id}>{label}</NativeSelectOption>)}
                </NativeSelect>
              </PreferenceRow>
              <PreferenceRow label={t("Close window behavior")} htmlFor="settings-close-behavior" description={mini.enabled ? t("The status bar icon needs Pic Piper to keep running in the background. Disable the icon to change this behavior.") : undefined} descriptionId="close-behavior-reason">
                <NativeSelect id="settings-close-behavior" aria-label={t("Close window behavior")} aria-describedby={mini.enabled ? "close-behavior-reason" : undefined} value={mini.enabled ? "background" : closeBehavior} disabled={mini.enabled} onChange={(event) => { setCloseBehavior(event.target.value as AppSettings["closeBehavior"]); setGeneralMessage(null); setGeneralError(null); }}>
                  <NativeSelectOption value="quit">{t("Quit application")}</NativeSelectOption>
                  <NativeSelectOption value="background">{t("Close window and run in background")}</NativeSelectOption>
                </NativeSelect>
              </PreferenceRow>
              <PreferenceRow label={t("Parallel image tasks")} htmlFor="settings-processing-concurrency" description={t("Auto uses 50% of available CPU cores, rounded up.")} descriptionId="processing-concurrency-description">
                <NativeSelect id="settings-processing-concurrency" aria-label={t("Parallel image tasks")} aria-describedby="processing-concurrency-description" value={processingConcurrency} onChange={(event) => { setProcessingConcurrency(Number(event.target.value)); setGeneralMessage(null); setGeneralError(null); }}>
                  <NativeSelectOption value={0}>{t("Auto ({{count}} tasks)", { count: defaultConcurrency })}</NativeSelectOption>
                  {Array.from({ length: cpuCount }, (_, index) => index + 1).map((count) => <NativeSelectOption key={count} value={count}>{t("{{count}} tasks", { count })}</NativeSelectOption>)}
                </NativeSelect>
              </PreferenceRow>
            </section>
            <section className="settings-group settings-preferences">
              <h3>{t("Quick compression")}</h3>
              <MiniPreferences value={mini} onChange={(value) => { setMini(value); setGeneralMessage(null); setGeneralError(null); }} profiles={settings.profiles} disabled={generalSaving} label="Show status bar icon" hint="Drag images to the icon or open Mini to compress and copy them." layout="rows" />
            </section>
            <footer className="settings-actions"><Button type="submit" disabled={generalSaving || !miniSettingsValid(mini, settings.profiles)}>{generalSaving ? t("Saving...") : t("Save general settings")}</Button></footer>
            {(generalSaving || generalMessage || generalError) && <div className="settings-status">
              {(generalSaving || generalMessage) && <p role="status">{generalSaving ? t("Saving...") : generalMessage}</p>}
              {generalError && <Alert variant="destructive"><AlertDescription>{generalError}</AlertDescription></Alert>}
            </div>}
          </fieldset>
          <UpdatePreferences isActive={isActive && section === "general"} />
        </Tabs.Panel>
        <Tabs.Panel value="oauth" id="settings-section-oauth" keepMounted render={<section />}>
          <h2 className="settings-title">{t("One-click authorization")}</h2>
          {section === "oauth" && isActive && <R2Connect onConnected={onSettingsChange} onBusyChange={setProviderBusy} disabled={saving || testingConnection} />}
        </Tabs.Panel>
        <Tabs.Panel value={section === "publishing" ? "publishing" : "storage"} id="settings-section-profile" keepMounted render={<form className="settings-sheet" onSubmit={handleSaveProfile} />}>
          <fieldset className="settings-fields" disabled={saving || providerBusy}>
            <header className="settings-heading">
              <h2 className="settings-title">{t(section === "publishing" ? "Links and naming" : "S3 profiles")}</h2>
              <Button variant="outline" type="button" aria-label={t("Add profile")} onClick={() => { setCreatingNew(true); changeSection("storage"); }}>{t("Add manually")}</Button>
            </header>
            {section === "storage" && <PreferenceRow label={t("One-click authorization")} description={t("Authorize your storage provider in a browser, then choose buckets to add.")}>
              <Button variant="outline" type="button" onClick={() => changeSection("oauth")}>{t("Add with an account")}<ArrowUpRight className="size-4" aria-hidden="true" /></Button>
            </PreferenceRow>}
            {settings.profiles.length > 1 && <PreferenceRow label={t("Editing profile")} htmlFor="settings-profile">
              <NativeSelect id="settings-profile" aria-label={t("Editing profile")} value={creatingNew ? "new" : editingProfileId} onChange={(event) => { setCreatingNew(false); setEditingProfileId(event.target.value); }}>
                {creatingNew && <NativeSelectOption value="new">{t("Add profile")}</NativeSelectOption>}
                {settings.profiles.map((entry) => <NativeSelectOption key={entry.id} value={entry.id}>{entry.name}</NativeSelectOption>)}
              </NativeSelect>
            </PreferenceRow>}
            <div hidden={section !== "storage"}>
              <section className="settings-group">
                <h3>{t("Connection")}</h3>
                <div className="field-grid">
                  {inputField("name", "Profile name", name, setName)}
                  {inputField("bucket", "Bucket", bucket, setBucket, { placeholder: "my-image-bucket" })}
                  <div className="field-full">{inputField("endpoint", "Endpoint", endpoint, setEndpoint, { placeholder: "https://s3.example.com" })}</div>
                  {inputField("region", "Region", region, setRegion)}
                </div>
                <PreferenceRow label={t("Path style addressing")} htmlFor="settings-path-style" description={t("Use bucket-in-path requests when your provider requires them.")} descriptionId="settings-path-style-description">
                  <Switch id="settings-path-style" aria-label={t("Path style addressing")} aria-describedby="settings-path-style-description" checked={pathStyle} onCheckedChange={setPathStyle} />
                </PreferenceRow>
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
                {inputField("namingTemplate", "Naming template", namingTemplate, setNamingTemplate)}
                <p className="field-hint">{t("Applies to all profiles")}</p>
              </section>
              <section className="settings-group">
                <PreferenceRow label={t("Use as default profile")} htmlFor="settings-default-profile" description={t("New compressions upload here unless you choose another profile.")} descriptionId="settings-default-profile-description">
                  <Switch id="settings-default-profile" aria-label={t("Use as default profile")} aria-describedby="settings-default-profile-description" checked={makeDefault} onCheckedChange={setMakeDefault} />
                </PreferenceRow>
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
        </Tabs.Panel>
      </div>
    </Tabs.Root>
  );
}
