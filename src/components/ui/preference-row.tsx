import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface PreferenceRowProps {
  label: ReactNode;
  description?: ReactNode;
  descriptionId?: string;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

export function PreferenceRow({ label, description, descriptionId, htmlFor, className, children }: PreferenceRowProps) {
  return <div className={cn("preference-row", className)}>
    <div className="preference-copy">
      {htmlFor ? <Label className="preference-label" htmlFor={htmlFor}>{label}</Label> : <div className="preference-label">{label}</div>}
      {description && <p className="preference-description" id={descriptionId}>{description}</p>}
    </div>
    <div className="preference-control">
      {htmlFor ? <Label htmlFor={htmlFor} className="preference-control-label">{children}</Label> : children}
    </div>
  </div>;
}
