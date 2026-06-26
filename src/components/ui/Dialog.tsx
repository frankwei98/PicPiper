import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useId, type ReactNode } from "react";
import { cn } from "../../utils/cn";

const popupClassName = cn(
  "fixed left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2",
  "grid gap-lg w-[min(100%,720px)]",
  "max-h-[calc(100dvh-48px)] overflow-auto",
  "border border-outline-variant rounded-lg p-xl",
  "bg-surface-container-high text-on-surface",
  "animate-in fade-in zoom-in-95 duration-200 ease-out",
  "outline-none",
);

const backdropClassName = cn(
  "fixed inset-0 z-20 flex items-center justify-center",
  "bg-black/50 p-xl",
  "animate-in fade-in duration-200 ease-out",
);

const dangerButtonClassName = cn(
  "rounded-md px-5 py-2.5 text-callout font-semibold",
  "bg-error-container text-on-error-container",
  "transition-[filter,box-shadow] duration-150 ease-out",
  "hover:brightness-115",
);

const secondaryButtonClassName = cn(
  "rounded-md px-5 py-2.5 text-callout font-medium",
  "bg-white/5 border border-outline-variant text-on-surface",
  "transition-colors duration-150 ease-out",
  "hover:bg-white/10 hover:border-outline",
);

interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
}

export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  className,
}: AlertDialogProps) {
  return (
    <BaseAlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop className={backdropClassName} />
        <BaseAlertDialog.Popup
          className={cn(popupClassName, className)}
        >
          <BaseAlertDialog.Title className="text-title-2 font-semibold text-on-surface text-balance">
            {title}
          </BaseAlertDialog.Title>
          <BaseAlertDialog.Description className="text-body text-on-surface-variant text-pretty">
            {description}
          </BaseAlertDialog.Description>
          <div className="flex gap-sm flex-wrap">
            <BaseAlertDialog.Close
              className={dangerButtonClassName}
              onClick={onConfirm}
            >
              {confirmLabel}
            </BaseAlertDialog.Close>
            <BaseAlertDialog.Close
              className={secondaryButtonClassName}
              onClick={onCancel}
            >
              {cancelLabel}
            </BaseAlertDialog.Close>
          </div>
        </BaseAlertDialog.Popup>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  );
}

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  className?: string;
}

export function Dialog({ open, onOpenChange, title, children, className }: DialogProps) {
  const titleId = useId();
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={backdropClassName} />
        <BaseDialog.Popup
          className={cn(popupClassName, className)}
          aria-labelledby={titleId}
        >
          <BaseDialog.Title id={titleId} className="text-title-2 font-semibold text-on-surface text-balance">
            {title}
          </BaseDialog.Title>
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

Dialog.Close = BaseDialog.Close;
