import type { ReactNode } from "react";
import { cn } from "../../utils/cn";

interface StatusMessageProps {
  children: ReactNode;
  variant?: "default" | "error";
  className?: string;
}

export function StatusMessage({ children, variant = "default", className }: StatusMessageProps) {
  return (
    <p
      role="status"
      className={cn(
        "text-footnote",
        variant === "error" ? "text-error" : "text-on-surface-variant",
        className,
      )}
    >
      {children}
    </p>
  );
}
