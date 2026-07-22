import { useEffect, useState } from "react";
import { settingsApi } from "../../api/tauri";
import type { AppSettings } from "../../api/tauri";
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
  }, [editingProfileId, creatingNew, settings.profiles]);

  // Sync naming template separately — it is app-level, not profile-level, and
  // arrives asynchronously after App's initial render with defaults.
  useEffect(() => {
    setNamingTemplate(settings.namingTemplate);
  }, [settings.namingTemplate]);

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

      // Validate publicBaseUrl if provided
      if (publicBaseUrl) {
        try {
          const parsed = new URL(publicBaseUrl);
          if (parsed.search || parsed.hash) {
            setSaving(false);
            setSaveError("Public Base URL must not contain query strings or fragments.");
            return;
          }
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            setSaving(false);
            setSaveError("Public Base URL must use http: or https: protocol.");
            return;
          }
        } catch {
          setSaving(false);
          setSaveError("Public Base URL is not a valid URL.");
          return;
        }
      }

      const profileId = profile?.id || crypto.randomUUID();

      const secretResult = secretAccessKey
        ? await settingsApi.saveS3Secret({
            profileId,
            secretAccessKey,
          })
        : {
            credentialRef: profile!.credentialRef!,
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
      setCreatingNew(false);
      setEditingProfileId(profileId);
    } catch (error) {
      setSaving(false);
      setSaveError(errorMessage(error, "Failed to save profile."));
    }
  };

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
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Label>
              <Label className="grid gap-2 items-start">
                Endpoint
                <Input placeholder="https://s3.example.com" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
              </Label>
              <Label className="grid gap-2 items-start">
                Region
                <Input value={region} onChange={(e) => setRegion(e.target.value)} />
              </Label>
              <Label className="grid gap-2 items-start">
                Bucket
                <Input placeholder="my-image-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} />
              </Label>
              <Label className="grid gap-2 items-start">
                Access key ID
                <Input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
              </Label>
              <Label className="grid gap-2 items-start">
                Secret access key
                <Input type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} />
              </Label>
              <Label className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <span>Path style addressing</span>
                <Switch checked={pathStyle} onCheckedChange={setPathStyle} />
              </Label>
              <Label className="grid gap-2 items-start">
                Naming template
                <Input value={namingTemplate} onChange={(e) => setNamingTemplate(e.target.value)} />
              </Label>
              <Label className="grid gap-2 items-start">
                Public Base URL
                <Input placeholder="https://cdn.example.com" value={publicBaseUrl} onChange={(e) => setPublicBaseUrl(e.target.value)} />
              </Label>
              <Label className="grid gap-2 items-start">
                Default prefix
                <Input placeholder="images/2026/06" value={defaultPrefix} onChange={(e) => setDefaultPrefix(e.target.value)} />
              </Label>
              <div className="col-span-2 flex gap-2 max-lg:col-span-1">
                <Button type="submit" disabled={saving}>Save profile</Button>
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
