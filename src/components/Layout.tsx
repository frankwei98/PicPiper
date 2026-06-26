import type { AppView } from "../types";
import { cn } from "../utils/cn";

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
    <main className="grid grid-cols-[220px_minmax(0,1fr)] min-h-dvh max-md:grid-cols-1">
      <aside className={cn(
        "bg-surface-container-lowest text-on-surface",
        "flex flex-col gap-xl",
        "border-r border-outline-variant",
        "sticky top-0 h-dvh overflow-y-auto",
        "px-lg py-xl",
        "max-md:relative max-md:h-auto max-md:border-r-0 max-md:border-b max-md:px-lg max-md:py-lg",
      )}>
        <div className="flex items-center gap-sm">
          <div
            className="size-8 bg-primary-container rounded-xs flex items-center justify-center text-lg shrink-0"
            aria-label="Pic Piper"
          >
            🎵
          </div>
          <h1 className="text-headline font-semibold text-on-surface text-balance">Pic Piper</h1>
        </div>
        <nav aria-label="Main navigation" className="grid gap-0.5 max-md:flex max-md:flex-wrap max-md:gap-sm">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onViewChange(item.id)}
              className={cn(
                "border-none rounded-xs cursor-pointer",
                "px-3 py-2.5 text-left text-callout font-medium",
                "transition-[background-color,color,opacity] duration-150 ease-out",
                "relative focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2",
                activeView === item.id
                  ? "bg-surface-tint text-on-primary-container opacity-100 font-semibold"
                  : "bg-transparent text-on-surface opacity-70 hover:bg-surface-container-high hover:opacity-100",
              )}
            >
              <span className="mr-sm text-lg inline-block w-5 text-center">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <section className="min-w-0 overflow-x-hidden py-xl px-margin-desktop max-md:py-lg max-md:px-margin-mobile">
        {children}
      </section>
    </main>
  );
}
