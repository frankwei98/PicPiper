import type { AppView } from "../types";

const NAV_ITEMS: Array<{ id: AppView; label: string }> = [
  { id: "optimize", label: "Optimize" },
  { id: "gallery", label: "S3 Gallery" },
  { id: "settings", label: "Settings" },
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
        <h1>Pic Piper</h1>
        <nav aria-label="Main navigation">
          {NAV_ITEMS.map((item) => (
            <button
              className={activeView === item.id ? "nav-button active" : "nav-button"}
              key={item.id}
              onClick={() => onViewChange(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <section className="workspace">{children}</section>
    </main>
  );
}
