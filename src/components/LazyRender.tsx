import { useEffect, useRef, useState, type ReactNode } from "react";

interface LazyRenderProps {
  as?: "div" | "li";
  className?: string;
  label: string;
  placeholder: ReactNode;
  children: () => ReactNode;
  position?: number;
  total?: number;
}

// Keep lightweight placeholders in the layout, but mount expensive card content
// only near the viewport. Unmounting also cancels queued thumbnail reads.
export function LazyRender({ as: Tag = "div", className, label, placeholder, children, position, total }: LazyRenderProps) {
  const node = useRef<HTMLElement>(null);
  const intersecting = useRef(false);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const element = node.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      intersecting.current = entry.isIntersecting;
      if (entry.isIntersecting) {
        setVisible(true);
        setHeight(undefined);
      } else if (!element.contains(document.activeElement)) {
        const measured = element.getBoundingClientRect().height;
        if (measured) setHeight(measured);
        setVisible(false);
      }
    }, { rootMargin: "400px 0px" });
    observer.observe(element);
    // Discard a stale reserved height if a responsive column/rail changes width.
    let width = element.getBoundingClientRect().width;
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(([entry]) => {
      if (entry.contentRect.width !== width) { width = entry.contentRect.width; setHeight(undefined); }
    });
    resize?.observe(element);
    return () => { observer.disconnect(); resize?.disconnect(); };
  }, []);
  return <Tag
    ref={(element: HTMLDivElement | HTMLLIElement | null) => { node.current = element; }}
    className={className}
    role={Tag === "div" && position ? "listitem" : undefined}
    aria-label={label}
    aria-posinset={position}
    aria-setsize={total}
    data-lazy-render={visible ? "mounted" : "placeholder"}
    tabIndex={visible ? undefined : 0}
    style={!visible && height ? { minHeight: height } : undefined}
    onFocusCapture={() => setVisible(true)}
    onBlurCapture={(event) => {
      if (!intersecting.current && !event.currentTarget.contains(event.relatedTarget) && typeof IntersectionObserver !== "undefined") {
        const measured = event.currentTarget.getBoundingClientRect().height;
        if (measured) setHeight(measured);
        setVisible(false);
      }
    }}
  >{visible ? children() : placeholder}</Tag>;
}
