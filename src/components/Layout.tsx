import type { AppView } from "../types";

const NAV_ITEMS: Array<{ id: AppView; label: string; icon: string }> = [
  { id: "optimize", label: "Optimize", icon: "⚡" },
  { id: "gallery", label: "S3 Gallery", icon: "🖼" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

interface LayoutProps {
  activeView: AppView;
  children: React.ReactNode;
  onViewChange: (view: AppView) => void;
}

export function Layout({ activeView, children, onViewChange }: LayoutProps) {
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-brand-icon">🎵</div>
          <h1>Pic Piper</h1>
        </div>
        <nav aria-label="Main navigation">
          {NAV_ITEMS.map((item) => (
            <button
              className={activeView === item.id ? "nav-button active" : "nav-button"}
              key={item.id}
              onClick={() => onViewChange(item.id)}
              type="button"
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <section className="workspace">{children}</section>
    </main>
  );
}
