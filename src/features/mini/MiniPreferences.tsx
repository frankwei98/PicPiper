import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { PreferenceRow } from "@/components/ui/preference-row";
import { useId } from "react";
import type { MiniSettings } from "@/api/backend";
import type { S3Profile, WritableImageFormat } from "@/types";
import { writableImageFormats } from "@/lib/imageFormats";
import { t, type MessageKey } from "@/i18n";

interface MiniPreferencesProps {
  value: MiniSettings;
  onChange: (value: MiniSettings) => void;
  profiles: S3Profile[];
  disabled?: boolean;
  label?: MessageKey;
  hint?: MessageKey;
  layout?: "stacked" | "rows";
}

export function miniSettingsValid(value: MiniSettings, _profiles: S3Profile[]): boolean {
  return !value.enabled || (Number.isInteger(value.quality) && value.quality >= 1 && value.quality <= 100);
}

const MINI_FORMATS = writableImageFormats().filter((format) => format !== "jxl");

export function MiniPreferences({ value, onChange, disabled = false, label = "Enable Mini", hint, layout = "stacked" }: MiniPreferencesProps) {
  const id = useId();
  const set = <K extends keyof MiniSettings>(key: K, next: MiniSettings[K]) => onChange({ ...value, [key]: next, action: "clipboard" });
  const setQuality = (raw: string) => {
    const next = Number(raw);
    if (Number.isFinite(next)) set("quality", Math.max(1, Math.min(100, Math.round(next))));
  };
  if (layout === "rows") return <div className="mini-preferences mini-preferences-rows">
    <PreferenceRow label={t(label)} htmlFor={`${id}-enabled`} description={hint ? t(hint) : undefined} descriptionId={`${id}-description`}>
      <Switch id={`${id}-enabled`} aria-label={t(label)} aria-describedby={hint ? `${id}-description` : undefined} checked={value.enabled} disabled={disabled} onCheckedChange={(checked) => set("enabled", checked)} />
    </PreferenceRow>
    {value.enabled && <>
      <PreferenceRow label={t("Default image format")} htmlFor={`${id}-format`}>
        <NativeSelect id={`${id}-format`} aria-label={t("Default image format")} value={value.targetFormat} disabled={disabled} onChange={(event) => set("targetFormat", event.target.value as WritableImageFormat)}>
          {MINI_FORMATS.map((format) => <NativeSelectOption key={format} value={format}>{format.toUpperCase()}</NativeSelectOption>)}
        </NativeSelect>
      </PreferenceRow>
      <PreferenceRow label={t("Default image quality")} htmlFor={`${id}-quality`}>
        <div className="preference-number"><Input id={`${id}-quality`} type="number" aria-label={t("Default image quality")} min={1} max={100} value={value.quality} disabled={disabled} onChange={(event) => setQuality(event.target.value)} /><span aria-hidden="true">%</span></div>
      </PreferenceRow>
    </>}
  </div>;

  return (
    <div className="mini-preferences">
      <Label className="field-switch mini-switch">
        <span>{t(label)}<small>{hint ? t(hint) : value.enabled ? t("Mini is on") : t("Mini is off")}</small></span>
        <Switch aria-label={t(label)} checked={value.enabled} disabled={disabled} onCheckedChange={(checked) => set("enabled", checked)} />
      </Label>
      {value.enabled && <div className="mini-options">
        <Label className="field"><span>{t("Image format")}</span>
          <NativeSelect aria-label={t("Image format")} value={value.targetFormat} disabled={disabled} onChange={(event) => set("targetFormat", event.target.value as WritableImageFormat)}>
            {MINI_FORMATS.map((format) => <NativeSelectOption key={format} value={format}>{format.toUpperCase()}</NativeSelectOption>)}
          </NativeSelect>
        </Label>
        <Label className="field"><span>{t("Quality")}</span>
          <input className="mini-quality" type="number" aria-label={t("Quality")} min={1} max={100} value={value.quality} disabled={disabled} onChange={(event) => setQuality(event.target.value)} />
        </Label>

      </div>}
    </div>
  );
}
