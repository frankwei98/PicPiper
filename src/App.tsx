import { useState } from "react";
import "./App.css";

type View = "optimize" | "gallery" | "settings";

const NAV_ITEMS: Array<{ id: View; label: string }> = [
  { id: "optimize", label: "Optimize" },
  { id: "gallery", label: "S3 Gallery" },
  { id: "settings", label: "Settings" },
];

function App() {
  const [view, setView] = useState<View>("optimize");

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <h1>Pic Piper</h1>
        <nav aria-label="Main navigation">
          {NAV_ITEMS.map((item) => (
            <button
              className={view === item.id ? "nav-button active" : "nav-button"}
              key={item.id}
              onClick={() => setView(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <section className="workspace">
        {view === "optimize" && <h2>Optimize</h2>}
        {view === "gallery" && <h2>S3 Gallery</h2>}
        {view === "settings" && <h2>Settings</h2>}
      </section>
    </main>
  );
}

export default App;
