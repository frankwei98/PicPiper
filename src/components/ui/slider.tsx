import * as React from "react"

import { cn } from "@/lib/utils"

type SliderProps = Omit<
  React.ComponentProps<"input">,
  "type" | "value" | "defaultValue" | "onChange"
> & {
  value?: number
  defaultValue?: number
  onValueChange?: (value: number) => void
  onValueCommitted?: (value: number) => void
}

function Slider({
  className,
  value,
  defaultValue,
  min = 0,
  max = 100,
  onValueChange,
  onValueCommitted,
  onKeyDown,
  onKeyUp,
  onBlur,
  ref,
  ...props
}: SliderProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const keyboardAdjusting = React.useRef(false)
  React.useImperativeHandle(ref, () => inputRef.current!, [])

  // React maps input onChange to each value update. The native change event
  // marks the browser's completed range interaction, without taking ownership
  // of its pointer capture or drag handling.
  React.useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const commit = () => {
      if (!keyboardAdjusting.current) onValueCommitted?.(input.valueAsNumber)
    }
    input.addEventListener("change", commit)
    return () => input.removeEventListener("change", commit)
  }, [onValueCommitted])

  const adjustmentKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]
  return (
    <input
      ref={inputRef}
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
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (!event.defaultPrevented && adjustmentKeys.includes(event.key)) keyboardAdjusting.current = true
      }}
      onKeyUp={(event) => {
        onKeyUp?.(event)
        if (keyboardAdjusting.current && adjustmentKeys.includes(event.key)) {
          keyboardAdjusting.current = false
          onValueCommitted?.(event.currentTarget.valueAsNumber)
        }
      }}
      onBlur={(event) => {
        onBlur?.(event)
        if (keyboardAdjusting.current) {
          keyboardAdjusting.current = false
          onValueCommitted?.(event.currentTarget.valueAsNumber)
        }
      }}
      {...props}
    />
  )
}

export { Slider }
