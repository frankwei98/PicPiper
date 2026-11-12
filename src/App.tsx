import { t, useLocale } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { Layout } from "./components/Layout";
import { S3GalleryPage } from "./features/gallery/S3GalleryPage";
import { OptimizePage } from "./features/optimize/OptimizePage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { settingsApi } from "./api/backend";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

  useEffect(() => {
    let cancelled = false;
    settingsApi
      .loadSettings()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch((error) => {
        if (!cancelled) setSettingsError(errorMessage(error, t("Failed to load settings.")));
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
        <SettingsPage settings={settings} onSettingsChange={setSettings} />
      </div>
    </Layout>
  );
}

export default App;
