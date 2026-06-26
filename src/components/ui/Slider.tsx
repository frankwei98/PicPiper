import { Slider as BaseSlider } from "@base-ui/react/slider";
import { cn } from "../../utils/cn";

interface SliderProps {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  "aria-label"?: string;
  className?: string;
}

export function Slider({ value, onValueChange, min = 1, max = 100, className, ...rest }: SliderProps) {
  return (
    <BaseSlider.Root
      value={value}
      onValueChange={(v) => onValueChange(Array.isArray(v) ? v[0] : v)}
      min={min}
      max={max}
      className={cn("relative flex h-5 w-full items-center", className)}
      aria-label={rest["aria-label"]}
    >
      <BaseSlider.Track className="h-1 w-full rounded-full bg-surface-container-high">
        <BaseSlider.Indicator className="rounded-full bg-primary-container" />
        <BaseSlider.Thumb
          className="size-5 rounded-full bg-primary-container cursor-pointer shadow-[0_1px_4px_rgba(0,0,0,0.3)] transition-transform duration-150 ease-out hover:scale-115 active:scale-95 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </BaseSlider.Track>
    </BaseSlider.Root>
  );
}
