import { cn } from "../../utils/cn";

export const btnBase =
  "border-none rounded-md cursor-pointer text-callout font-medium px-5 py-2.5 transition-[background-color,box-shadow,filter] duration-150 ease-out inline-flex items-center justify-center gap-sm leading-none focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-38 disabled:cursor-not-allowed disabled:pointer-events-none";

export const btnPrimary = cn(
  btnBase,
  "bg-primary-container text-on-primary-container font-semibold hover:shadow-[0_1px_3px_rgba(0,0,0,0.3)] hover:brightness-110",
);

export const btnSecondary = cn(
  btnBase,
  "bg-white/5 border border-outline-variant text-on-surface hover:bg-white/10 hover:border-outline",
);

export const btnDanger = cn(
  btnBase,
  "bg-error-container text-on-error-container hover:brightness-115",
);

export const btnTertiary = cn(
  btnBase,
  "bg-transparent text-primary px-3 hover:bg-[rgba(255,189,127,0.1)]",
);

export const btnSm = "text-footnote px-3 py-1.5 rounded-md";

export const inputClass =
  "rounded-md border border-outline-variant bg-surface-container text-on-surface p-2.5 text-body transition-[border-color,box-shadow] duration-150 ease-out focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 w-full";

export const labelClass = "grid gap-xs text-footnote font-medium text-on-surface-variant";
