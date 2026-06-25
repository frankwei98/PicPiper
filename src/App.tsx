import { useState } from "react";
import { Layout } from "./components/Layout";
import { S3GalleryPage } from "./features/gallery/S3GalleryPage";
import { OptimizePage } from "./features/optimize/OptimizePage";
import { SettingsPage } from "./features/settings/SettingsPage";
import type { AppView } from "./types";
import "./App.css";

function App() {
  const [view, setView] = useState<AppView>("optimize");

  return (
    <Layout activeView={view} onViewChange={setView}>
      {view === "optimize" && <OptimizePage />}
      {view === "gallery" && <S3GalleryPage />}
      {view === "settings" && <SettingsPage />}
    </Layout>
  );
}

export default App;
