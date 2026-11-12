import { useEffect, useRef, useState } from "react";
import { settingsApi } from "../../api/backend";
import type { AppSettings } from "../../api/backend";
import type { S3Profile } from "../../types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `${label} must use http: or https: protocol.`;
    if (!parsed.hostname) return `${label} must include a host.`;
    if (parsed.username || parsed.password) return `${label} must not include credentials.`;
    if (parsed.search || parsed.hash) return `${label} must not contain query strings or fragments.`;
  } catch {
    return `${label} is not a valid URL.`;
  }
}

export function SettingsPage({ settings, onSettingsChange }: SettingsPageProps) {
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
    if (!name.trim()) errors.name = "Profile name is required.";
    if (!endpoint.trim()) errors.endpoint = "Endpoint is required.";
    else errors.endpoint = httpUrlError(endpoint, "Endpoint");
    if (!region.trim()) errors.region = "Region is required.";
    if (!bucket.trim()) errors.bucket = "Bucket is required.";
    if (!accessKeyId.trim()) errors.accessKeyId = "Access key ID is required.";
    if (!secretAccessKey && !profile?.credentialRef) errors.secretAccessKey = missingSecretMessage;
    if (publicBaseUrl.trim()) errors.publicBaseUrl = httpUrlError(publicBaseUrl, "Public Base URL");
    if (defaultPrefix.split("/").some((segment) => segment === "." || segment === "..")) {
      errors.defaultPrefix = "Default prefix must not contain path traversal segments.";
    } else if (Array.from(defaultPrefix).some((character) => /[\u0000-\u001f\u007f]/.test(character))) {
      errors.defaultPrefix = "Default prefix must not contain control characters.";
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
    const validationErrors = validateProfileFields("Enter a secret access key to test this new profile.");
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
      setConnectionMessage("Connection successful. Bucket listing works.");
    } catch (error) {
      if (generation !== connectionGenerationRef.current) return;
      setConnectionError(errorMessage(error, "Connection test failed."));
    } finally {
      setTestingConnection(false);
    }
  };

  const handleSaveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaveError(null);
    setSaveMessage(null);
    const errors = validateProfileFields("Secret access key is required for a new profile.");
    if (!namingTemplate.trim()) errors.namingTemplate = "Naming template is required.";
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
            `${errorMessage(error, "Failed to save profile.")} The previous settings could not be restored: ${errorMessage(rollbackError, "Unknown error.")}`,
          );
          return;
        }
        throw error;
      }
      onSettingsChange(nextSettings);
      setSecretAccessKey("");
      setSaving(false);
      setSaveMessage("Profile saved.");
      setCreatingNew(false);
      setEditingProfileId(profileId);
    } catch (error) {
      setSaving(false);
      setSaveError(errorMessage(error, "Failed to save profile."));
    }
  };

  const fieldProps = (field: ProfileField) => ({
    ref: (element: HTMLInputElement | null) => { if (element) fieldRefs.current[field] = element; },
    "aria-invalid": Boolean(fieldErrors[field]),
    "aria-describedby": fieldErrors[field] ? `${field}-error` : undefined,
  });

  const renderFieldError = (field: ProfileField) => fieldErrors[field]
    ? <span id={`${field}-error`} className="text-xs text-destructive">{fieldErrors[field]}</span>
    : null;

  return (
    <div className="grid max-w-5xl gap-6">
      <header className="flex justify-between items-start gap-6">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight text-balance">Settings</h2>
          <p className="text-muted-foreground mt-2 text-sm text-pretty">Manage S3 profiles, naming, and output defaults.</p>
        </div>
      </header>
      <section className="grid gap-6">
        {settings.profiles.length > 1 && (
          <Label className="grid gap-2 items-start">
            Editing profile
            <NativeSelect
              className="w-full max-w-sm"
              value={editingProfileId}
              onChange={(e) => setEditingProfileId(e.target.value)}
            >
              {settings.profiles.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>{p.name}</NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>S3 credentials are stored locally on this device.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <form className="grid gap-4 grid-cols-2 max-lg:grid-cols-1" onSubmit={handleSaveProfile}>
              <Label className="grid gap-2 items-start">
                Profile name
                <Input {...fieldProps("name")} value={name} onChange={(e) => setName(e.target.value)} />
                {renderFieldError("name")}
              </Label>
              <Label className="grid gap-2 items-start">
                Endpoint
                <Input {...fieldProps("endpoint")} placeholder="https://s3.example.com" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
                {renderFieldError("endpoint")}
              </Label>
              <Label className="grid gap-2 items-start">
                Region
                <Input {...fieldProps("region")} value={region} onChange={(e) => setRegion(e.target.value)} />
                {renderFieldError("region")}
              </Label>
              <Label className="grid gap-2 items-start">
                Bucket
                <Input {...fieldProps("bucket")} placeholder="my-image-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} />
                {renderFieldError("bucket")}
              </Label>
              <Label className="grid gap-2 items-start">
                Access key ID
                <Input {...fieldProps("accessKeyId")} value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
                {renderFieldError("accessKeyId")}
              </Label>
              <Label className="grid gap-2 items-start">
                Secret access key
                <Input {...fieldProps("secretAccessKey")} type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} />
                {renderFieldError("secretAccessKey")}
              </Label>
              <Label className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <span>Path style addressing</span>
                <Switch checked={pathStyle} onCheckedChange={setPathStyle} />
              </Label>
              <Label className="grid gap-2 items-start">
                Naming template
                <Input {...fieldProps("namingTemplate")} value={namingTemplate} onChange={(e) => setNamingTemplate(e.target.value)} />
                {renderFieldError("namingTemplate")}
              </Label>
              <Label className="grid gap-2 items-start">
                Public Base URL
                <Input {...fieldProps("publicBaseUrl")} placeholder="https://cdn.example.com" value={publicBaseUrl} onChange={(e) => setPublicBaseUrl(e.target.value)} />
                {renderFieldError("publicBaseUrl")}
              </Label>
              <Label className="grid gap-2 items-start">
                Default prefix
                <Input {...fieldProps("defaultPrefix")} placeholder="images/2026/06" value={defaultPrefix} onChange={(e) => setDefaultPrefix(e.target.value)} />
                {renderFieldError("defaultPrefix")}
              </Label>
              <Label className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <span>Use as default profile</span>
                <Switch checked={makeDefault} onCheckedChange={setMakeDefault} />
              </Label>
              <div className="col-span-2 flex gap-2 max-lg:col-span-1">
                <Button type="submit" disabled={saving}>Save profile</Button>
                <Button variant="outline" type="button" onClick={handleTestConnection} disabled={testingConnection || saving}>
                  {testingConnection ? "Testing..." : "Test connection"}
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => setCreatingNew(true)}
                >
                  Add profile
                </Button>
              </div>
            </form>
            {saving && <p className="text-sm text-muted-foreground">Saving profile...</p>}
            {saveMessage && <p className="text-sm text-muted-foreground">{saveMessage}</p>}
            {connectionMessage && <p className="text-sm text-muted-foreground" role="status">{connectionMessage}</p>}
            {connectionError && (
              <Alert variant="destructive"><AlertDescription>{connectionError}</AlertDescription></Alert>
            )}
            {saveError && (
              <Alert variant="destructive">
                <AlertDescription>{saveError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
