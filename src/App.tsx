import { useState } from "react";
import { Layout } from "./components/Layout";
import { S3GalleryPage } from "./features/gallery/S3GalleryPage";
import { OptimizePage } from "./features/optimize/OptimizePage";
import { SettingsPage } from "./features/settings/SettingsPage";
import type { AppSettings } from "./api/tauri";
import type { S3Profile } from "./types";
import type { GalleryFocus } from "./state/appState";
import { initialNavigationState } from "./state/appState";
import type { AppNavigationState } from "./state/appState";
import "./App.css";

function App() {
  const [navigation, setNavigation] = useState<AppNavigationState>(initialNavigationState);
  const [settings, setSettings] = useState<AppSettings>({
    profiles: [],
    presets: [],
    namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
  });

  const openGallery = (focus: GalleryFocus) => {
    setNavigation({ view: "gallery", galleryFocus: focus });
  };

  const selectedProfile: S3Profile | undefined = navigation.galleryFocus.profile
    ?? settings.profiles[0];

  return (
    <Layout
      activeView={navigation.view}
      onViewChange={(view) => setNavigation((prev) => ({ ...prev, view }))}
    >
      {navigation.view === "optimize" && (
        <OptimizePage
          activeProfile={selectedProfile}
          namingTemplate={settings.namingTemplate}
          onUploadedToS3={openGallery}
        />
      )}
      {navigation.view === "gallery" && (
        <S3GalleryPage
          galleryFocus={navigation.galleryFocus}
          profiles={settings.profiles}
        />
      )}
      {navigation.view === "settings" && (
        <SettingsPage settings={settings} onSettingsChange={setSettings} />
      )}
    </Layout>
  );
}

export default App;
