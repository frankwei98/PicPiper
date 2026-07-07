import * as React from "react"

import { cn } from "@/lib/utils"

type SliderProps = Omit<
  React.ComponentProps<"input">,
  "type" | "value" | "defaultValue" | "onChange"
> & {
  value?: number
  defaultValue?: number
  onValueChange?: (value: number) => void
}

function Slider({
  className,
  value,
  defaultValue,
  min = 0,
  max = 100,
  onValueChange,
  ...props
}: SliderProps) {
  return (
    <input
      data-slot="slider"
      type="range"
      value={value}
      defaultValue={defaultValue}
      min={min}
      max={max}
      className={cn(
        "h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary outline-none transition-colors",
        "focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      onChange={(event) => onValueChange?.(event.currentTarget.valueAsNumber)}
      {...props}
    />
  )
}

export { Slider }
