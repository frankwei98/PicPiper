import { t, useLocale } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { OnboardingWizard } from "./features/onboarding/OnboardingWizard";
import { Button } from "@/components/ui/button";
import { Layout } from "./components/Layout";
import { S3GalleryPage } from "./features/gallery/S3GalleryPage";
import { OptimizePage } from "./features/optimize/OptimizePage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { imageApi, settingsApi, type ProcessingLimits } from "./api/backend";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import type { AppSettings } from "./api/backend";
import type { GalleryFocus } from "./state/appState";
import { initialNavigationState } from "./state/appState";
import type { AppNavigationState } from "./state/appState";
import { errorMessage } from "./lib/error";
import { updateApi } from "./api/updates";

function App() {
  const locale = useLocale();
  const [restartDeferred, setRestartDeferred] = useState(false);
  useEffect(() => { void updateApi.language().catch(() => {}); }, [locale]);
  useEffect(() => updateApi.subscribe(() => {
    void updateApi.state().then((state) => setRestartDeferred(state.restartDeferred)).catch(() => {});
  }), []);
  const [navigation, setNavigation] = useState<AppNavigationState>(initialNavigationState);
  const [settings, setSettings] = useState<AppSettings>({
    profiles: [],
    namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
  });
  const [processingLimits, setProcessingLimits] = useState<ProcessingLimits>();
  const applySettings = (next: AppSettings) => {
    setSettings(next);
    setProcessingLimits((current) => current ? { ...current, concurrency: next.processingConcurrency || current.defaultConcurrency } : current);
  };
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => settingsApi.onChanged?.(() => {
    // Native preference changes must not reset unsaved storage form fields.
    void Promise.all([settingsApi.loadSettings(), imageApi.processingLimits()]).then(([latest, limits]) => {
      setSettings((current) => ({ ...current, mini: latest.mini, closeBehavior: latest.closeBehavior, processingConcurrency: latest.processingConcurrency }));
      setProcessingLimits(limits);
    }).catch(() => {});
  }), []);

  useEffect(() => {
    setSettingsError(null);
    let cancelled = false;
    Promise.all([settingsApi.loadSettings(), imageApi.processingLimits()])
      .then(([loaded, limits]) => {
        if (!cancelled) {
          setSettings(loaded);
          setProcessingLimits(limits);
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
      {restartDeferred && <Alert className="app-notice"><AlertDescription>{t("Finish your current tasks, then quit and reopen Pic Piper to use the update.")}</AlertDescription></Alert>}
      {settingsError && (
        <Alert variant="destructive" className="app-notice">
          <AlertTitle>{t("Could not load settings")}</AlertTitle>
          <AlertDescription>{settingsError}</AlertDescription>
        </Alert>
      )}
      <div hidden={navigation.view !== "optimize"} className="app-panel">
        <OptimizePage
          processingConcurrency={processingLimits?.concurrency}
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
        <SettingsPage settings={settings} processingLimits={processingLimits} onSettingsChange={applySettings} isActive={navigation.view === "settings"} />
      </div>
    </Layout>
  );
}

export default App;
