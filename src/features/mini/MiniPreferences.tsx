import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { MiniSettings } from "@/api/backend";
import type { S3Profile, WritableImageFormat } from "@/types";
import { writableImageFormats } from "@/lib/imageFormats";
import { t } from "@/i18n";

interface MiniPreferencesProps {
  value: MiniSettings;
  onChange: (value: MiniSettings) => void;
  profiles: S3Profile[];
  disabled?: boolean;
}

export function miniSettingsValid(value: MiniSettings, _profiles: S3Profile[]): boolean {
  return !value.enabled || (Number.isInteger(value.quality) && value.quality >= 1 && value.quality <= 100);
}

const MINI_FORMATS = writableImageFormats().filter((format) => format !== "jxl");

export function MiniPreferences({ value, onChange, disabled = false }: MiniPreferencesProps) {
  const set = <K extends keyof MiniSettings>(key: K, next: MiniSettings[K]) => onChange({ ...value, [key]: next, action: "clipboard" });


  return (
    <div className="mini-preferences">
      <Label className="field-switch mini-switch">
        <span>{t("Enable Mini")}<small>{value.enabled ? t("Mini is on") : t("Mini is off")}</small></span>
        <Switch aria-label={t("Enable Mini")} checked={value.enabled} disabled={disabled} onCheckedChange={(checked) => set("enabled", checked)} />
      </Label>
      {value.enabled && <div className="mini-options">
        <Label className="field"><span>{t("Image format")}</span>
          <NativeSelect aria-label={t("Image format")} value={value.targetFormat} disabled={disabled} onChange={(event) => set("targetFormat", event.target.value as WritableImageFormat)}>
            {MINI_FORMATS.map((format) => <NativeSelectOption key={format} value={format}>{format.toUpperCase()}</NativeSelectOption>)}
          </NativeSelect>
        </Label>
        <Label className="field"><span>{t("Quality")}</span>
          <input className="mini-quality" type="number" aria-label={t("Quality")} min={1} max={100} value={value.quality} disabled={disabled} onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) set("quality", Math.max(1, Math.min(100, Math.round(next))));
          }} />
        </Label>

      </div>}
    </div>
  );
}
