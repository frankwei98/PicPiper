import { t, useLocale } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { OnboardingWizard } from "./features/onboarding/OnboardingWizard";
import { Button } from "@/components/ui/button";
import { Layout } from "./components/Layout";
import { S3GalleryPage } from "./features/gallery/S3GalleryPage";
import { OptimizePage } from "./features/optimize/OptimizePage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { settingsApi } from "./api/backend";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import type { AppSettings } from "./api/backend";
import type { GalleryFocus } from "./state/appState";
import { initialNavigationState } from "./state/appState";
import type { AppNavigationState } from "./state/appState";
import { errorMessage } from "./lib/error";

function App() {
  useLocale();
  const [navigation, setNavigation] = useState<AppNavigationState>(initialNavigationState);
  const [settings, setSettings] = useState<AppSettings>({
    profiles: [],
    namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
  });
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    setSettingsError(null);
    let cancelled = false;
    settingsApi
      .loadSettings()
      .then((loaded) => {
        if (!cancelled) {
          setSettings(loaded);
          if (loaded.features && !loaded.features.compression && loaded.features.s3) {
            setNavigation((current) => ({ ...current, view: "gallery" }));
          }
          setLoaded(true);
        }
      })
      .catch((error) => {
        if (!cancelled) setSettingsError(errorMessage(error, t("Failed to load settings.")));
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const recordUpload = (focus: GalleryFocus) => {
    setNavigation((current) => ({ ...current, galleryFocus: focus }));
  };

  const selectedProfile = useMemo(() => {
    const defaultId = settings.defaultProfileId;
    return (
      (defaultId ? settings.profiles.find((p) => p.id === defaultId) : undefined) ??
      settings.profiles[0]
    );
  }, [settings.defaultProfileId, settings.profiles]);

  if (!loaded) return <main className="onboarding-shell"><section className="onboarding-sheet">
    <h1>Pic Piper</h1>
    {settingsError ? <><p role="alert">{settingsError}</p><Button onClick={() => setLoadAttempt((value) => value + 1)}>{t("Retry")}</Button></> : <div role="status" aria-label={t("Loading settings...")} className="space-y-3">
      <p>{t("Loading settings...")}</p>
      <Skeleton className="h-8 w-2/3" aria-hidden="true" />
      <Skeleton className="h-4 w-full" aria-hidden="true" />
      <Skeleton className="h-4 w-4/5" aria-hidden="true" />
    </div>}
  </section></main>;

  if (!settings.onboardingCompleted && settings.profiles.length === 0) return <OnboardingWizard settings={settings} onComplete={(next) => {
    setSettings(next);
    if (!next.features?.compression && next.features?.s3) setNavigation((current) => ({ ...current, view: "gallery" }));
  }} />;

  return (
    <Layout
      activeView={navigation.view}
      onViewChange={(view) => setNavigation((prev) => ({ ...prev, view }))}
    >
      {settingsError && (
        <Alert variant="destructive" className="app-notice">
          <AlertTitle>{t("Could not load settings")}</AlertTitle>
          <AlertDescription>{settingsError}</AlertDescription>
        </Alert>
      )}
      <div hidden={navigation.view !== "optimize"} className="app-panel">
        <OptimizePage
          profiles={settings.profiles}
          activeProfile={selectedProfile}
          namingTemplate={settings.namingTemplate}
          isActive={navigation.view === "optimize"}
          onUploadedToS3={recordUpload}
          onOpenGallery={() => setNavigation((current) => ({ ...current, view: "gallery" }))}
        />
      </div>
      {navigation.view === "gallery" && (
        <S3GalleryPage
          galleryFocus={navigation.galleryFocus}
          profiles={settings.profiles}
          defaultProfileId={settings.defaultProfileId}
          namingTemplate={settings.namingTemplate}
          onNavigate={(view) => setNavigation((prev) => ({ ...prev, view }))}
        />
      )}
      <div hidden={navigation.view !== "settings"} className="app-panel">
        <SettingsPage settings={settings} onSettingsChange={setSettings} isActive={navigation.view === "settings"} />
      </div>
    </Layout>
  );
}

export default App;
