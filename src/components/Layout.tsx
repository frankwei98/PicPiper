import type { AppView } from "../types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ImageIcon, Images, Settings, Zap } from "lucide-react";

const NAV_ITEMS: Array<{ id: AppView; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "optimize", label: "Optimize", icon: Zap },
  { id: "gallery", label: "S3 Gallery", icon: Images },
  { id: "settings", label: "Settings", icon: Settings },
];

interface LayoutProps {
  activeView: AppView;
  children: React.ReactNode;
  onViewChange: (view: AppView) => void;
}

export function Layout({ activeView, children, onViewChange }: LayoutProps) {
  return (
    <main className="grid grid-cols-[220px_minmax(0,1fr)] min-h-dvh max-md:grid-cols-1">
      <aside className={cn(
        "bg-sidebar text-sidebar-foreground",
        "flex flex-col gap-8",
        "border-r border-sidebar-border",
        "sticky top-0 h-dvh overflow-y-auto",
        "px-6 py-8",
        "max-md:relative max-md:h-auto max-md:border-r-0 max-md:border-b max-md:px-5 max-md:py-5",
      )}>
        <div className="flex items-center gap-2">
          <div
            className="size-8 bg-sidebar-primary text-sidebar-primary-foreground rounded-lg flex items-center justify-center shrink-0"
            aria-hidden="true"
          >
            <ImageIcon className="size-4" />
          </div>
          <h1 className="text-base font-semibold text-sidebar-foreground text-balance">Pic Piper</h1>
        </div>
        <nav aria-label="Main navigation" className="grid gap-1 max-md:flex max-md:flex-wrap max-md:gap-2">
          {NAV_ITEMS.map((item) => (
            <Button
              key={item.id}
              variant={activeView === item.id ? "secondary" : "ghost"}
              type="button"
              onClick={() => onViewChange(item.id)}
              className={cn(
                "w-full justify-start gap-2",
                activeView === item.id
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                  : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/70",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </Button>
          ))}
        </nav>
      </aside>
      <section className="min-w-0 overflow-x-hidden py-8 px-10 max-md:py-6 max-md:px-4">
        {children}
      </section>
    </main>
  );
}
