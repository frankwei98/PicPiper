import type { AppView } from "../types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Images, Settings, Zap } from "lucide-react";

const NAV_ITEMS: Array<{ id: AppView; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "optimize", label: "Compress", icon: Zap },
  { id: "gallery", label: "S3 Gallery", icon: Images },
  { id: "settings", label: "Settings", icon: Settings },
];

interface LayoutProps {
  activeView: AppView;
  children: React.ReactNode;
  onViewChange: (view: AppView) => void;
}

function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

  const tabs = Array.from(
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
  );
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex === -1) return;

  event.preventDefault();

  let nextIndex = currentIndex;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = tabs.length - 1;
  if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;

  tabs[nextIndex]?.focus();
  tabs[nextIndex]?.click();
}

export function Layout({ activeView, children, onViewChange }: LayoutProps) {
  const startWindowDrag = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    try {
      void getCurrentWindow().startDragging().catch(() => {});
    } catch {
      // Browser-based previews do not provide Tauri window APIs.
    }
  };

  return (
    <main className="relative flex h-dvh flex-col overflow-hidden bg-background">
      <header className="sticky top-0 z-20 h-14 shrink-0 border-b bg-background/95 shadow-[0_1px_0_oklch(0_0_0/0.02)] backdrop-blur-md">
        <div
          data-tauri-drag-region
          className="absolute inset-0"
          aria-hidden="true"
          onMouseDown={startWindowDrag}
        />
        <nav
          aria-label="Main navigation"
          className="pointer-events-auto absolute top-1/2 left-1/2 z-10 min-w-0 -translate-x-1/2 -translate-y-1/2"
        >
          <div
            role="tablist"
            aria-label="Views"
            className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-xl bg-muted/70 p-1 ring-1 ring-border/70"
          >
            {NAV_ITEMS.map((item) => {
              const selected = activeView === item.id;
              return (
                <Button
                  key={item.id}
                  id={`app-tab-${item.id}`}
                  role="tab"
                  aria-controls={`app-panel-${item.id}`}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => onViewChange(item.id)}
                  onKeyDown={handleTabKeyDown}
                  className={cn(
                    "h-7 gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground",
                    "hover:bg-background/70 hover:text-foreground",
                    selected && "bg-background text-foreground shadow-sm ring-1 ring-border/70 hover:bg-background",
                  )}
                >
                  <item.icon className="size-3.5" />
                  {item.label}
                </Button>
              );
            })}
          </div>
        </nav>
      </header>
      <section
        id={`app-panel-${activeView}`}
        role="tabpanel"
        aria-labelledby={`app-tab-${activeView}`}
        className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-10 pt-6 pb-8 max-md:px-6 max-sm:px-4 max-sm:pb-6", activeView === "optimize" && "scroll-pb-64")}
      >
        {children}
      </section>
    </main>
  );
}
