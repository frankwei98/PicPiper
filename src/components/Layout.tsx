import type { AppView } from "../types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Images, Settings2, WandSparkles } from "lucide-react";

const NAV_ITEMS: Array<{ id: AppView; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "optimize", label: "Compress", icon: WandSparkles },
  { id: "gallery", label: "S3 Gallery", icon: Images },
  { id: "settings", label: "Settings", icon: Settings2 },
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
  return (
    <main className="app-shell">
      <aside className="app-sidebar" aria-label="Pic Piper">
        <div className="brand-mark" aria-hidden="true"><span /></div>
        <div className="brand-copy"><strong>Pic Piper</strong><span>Image workbench</span></div>
        <div className="sidebar-rule" />
        <nav aria-label="Main navigation">
          <p className="sidebar-caption">Workspace</p>
          <div role="tablist" aria-label="Views" className="sidebar-nav">
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
              const selected = activeView === id;
              return <Button key={id} id={`app-tab-${id}`} role="tab" aria-controls={`app-panel-${id}`} aria-selected={selected} tabIndex={selected ? 0 : -1} variant="ghost" type="button" onClick={() => onViewChange(id)} onKeyDown={handleTabKeyDown} className={cn("nav-item", selected && "nav-item-selected")}>
                <Icon aria-hidden="true" className="size-4" /><span>{label}</span>{selected && <span className="nav-indicator" aria-hidden="true" />}
              </Button>;
            })}
          </div>
        </nav>
        <div className="sidebar-foot"><span className="status-dot" />Ready for images</div>
      </aside>
      <section className="app-main">
        <header className="workspace-bar">
          <span>{NAV_ITEMS.find((item) => item.id === activeView)?.label}</span>
          <span className="workspace-bar-note">Local image preparation and S3 sharing</span>
        </header>
        <section id={`app-panel-${activeView}`} role="tabpanel" aria-labelledby={`app-tab-${activeView}`} className={cn("workspace-scroll", activeView === "optimize" && "compression-scroll")}>
          {children}
        </section>
      </section>
    </main>
  );
}
