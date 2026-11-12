import * as React from "react"

import { cn } from "@/lib/utils"

type SwitchProps = Omit<
  React.ComponentProps<"input">,
  "type" | "onChange" | "size"
> & {
  onCheckedChange?: (checked: boolean) => void
  size?: "sm" | "default"
}

function Switch({
  className,
  checked,
  defaultChecked,
  disabled,
  onCheckedChange,
  size = "default",
  ...props
}: SwitchProps) {
  return (
    <span
      data-slot="switch"
      data-size={size}
      className={cn("relative inline-flex shrink-0 items-center", className)}
    >
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        defaultChecked={defaultChecked}
        disabled={disabled}
        onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
        {...props}
      />
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex rounded-full border border-transparent bg-input transition-all outline-none",
          "peer-focus-visible:border-ring peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50",
          "peer-checked:bg-primary peer-disabled:cursor-not-allowed peer-disabled:opacity-50 dark:bg-input/80",
          "dark:peer-checked:[&>span]:bg-primary-foreground",
          size === "sm"
            ? "h-3.5 w-6 peer-checked:[&>span]:translate-x-[10px]"
            : "h-[18px] w-8 peer-checked:[&>span]:translate-x-3.5"
        )}
      >
        <span
          className={cn(
            "block rounded-full bg-background transition-transform dark:bg-foreground",
            size === "sm" ? "size-3" : "size-4"
          )}
        />
      </span>
    </span>
  )
}

export { Switch }
