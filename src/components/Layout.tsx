import { t, useLocale } from "@/i18n";
import type { AppView } from "../types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV_ITEMS: Array<{ id: AppView; label: import("@/i18n").MessageKey }> = [
  { id: "optimize", label: "Compress" },
  { id: "gallery", label: "S3 Gallery" },
  { id: "settings", label: "Settings" },
];

interface LayoutProps {
  activeView: AppView;
  children: React.ReactNode;
  onViewChange: (view: AppView) => void;
}

function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex === -1) return;
  event.preventDefault();
  const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowLeft" ? (currentIndex - 1 + tabs.length) % tabs.length : (currentIndex + 1) % tabs.length;
  tabs[nextIndex]?.focus();
  tabs[nextIndex]?.click();
}

export function Layout({ activeView, children, onViewChange }: LayoutProps) {
  useLocale();
  return (
    <main className="app-shell">
      <header className="masthead">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Pic Piper</span>
        </div>
        <nav aria-label={t("Main navigation")}>
          <div role="tablist" aria-label={t("Views")} className="masthead-nav">
            {NAV_ITEMS.map(({ id, label }) => {
              const selected = activeView === id;
              return (
                <Button
                  key={id}
                  id={`app-tab-${id}`}
                  role="tab"
                  aria-controls={`app-panel-${id}`}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  variant="ghost"
                  type="button"
                  onClick={() => onViewChange(id)}
                  onKeyDown={handleTabKeyDown}
                  className={cn("nav-item", selected && "nav-item-selected")}
                >
                  {t(label)}
                </Button>
              );
            })}
          </div>
        </nav>
        <div className="masthead-status">
          <span className="status-dot" aria-hidden="true" />
          {t("Local processing")}
        </div>
      </header>
      <section className="app-main">
        <section
          id={`app-panel-${activeView}`}
          role="tabpanel"
          aria-labelledby={`app-tab-${activeView}`}
          className={cn("workspace-scroll", activeView === "optimize" && "compression-scroll")}
        >
          {children}
        </section>
      </section>
    </main>
  );
}
