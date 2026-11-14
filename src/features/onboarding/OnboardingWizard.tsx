import { R2Connect } from "@/features/storage/R2Connect";
import { useState } from "react";
import { Cloud, ImageDown, ArrowRight, Check } from "lucide-react";
import { t, useLocale } from "@/i18n";
import { Button } from "@/components/ui/button";
import type { AppSettings, MiniSettings } from "@/api/backend";
import { defaultMiniSettings, settingsApi } from "@/api/backend";
import { errorMessage } from "@/lib/error";
import { MiniPreferences, miniSettingsValid } from "@/features/mini/MiniPreferences";

type Features = NonNullable<AppSettings["features"]>;
interface Props {
  settings: AppSettings;
  onComplete: (settings: AppSettings) => void;
}

export function OnboardingWizard({ settings, onComplete }: Props) {
  useLocale();
  const [connectedSettings, setConnectedSettings] = useState(settings);
  const [connecting, setConnecting] = useState(false);
  const [features, setFeatures] = useState<Features>({ compression: true, s3: false });
  const [step, setStep] = useState<"features" | "provider" | "mini">("features");
  const [mini, setMini] = useState<MiniSettings>({ ...(settings.mini ?? defaultMiniSettings), action: "clipboard" });
  const [provider, setProvider] = useState<"r2" | "other">("r2");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const complete = async () => {
    setSaving(true);
    setError(undefined);
    if (!miniSettingsValid(mini, connectedSettings.profiles)) {
      setError(t("Could not save setup. Please try again."));
      setSaving(false);
      return;
    }
    const next = { ...connectedSettings, onboardingCompleted: true, features, mini };
    try {
      await settingsApi.saveSettings(next);
      onComplete(next);
    } catch (cause) {
      setError(errorMessage(cause, t("Could not save setup. Please try again.")));
      setSaving(false);
    }
  };

  const skipR2 = step === "provider" && provider === "r2" && connectedSettings.profiles.length === 0;

  return (
    <main className="onboarding-shell">
      <div className="onboarding-brand"><span className="brand-mark" aria-hidden="true" />Pic Piper</div>
      <section className="onboarding-sheet" aria-labelledby="onboarding-title" aria-busy={saving}>
        <ol className="onboarding-steps" aria-label={t("Welcome to Pic Piper")}>
          <li aria-current={step === "features" ? "step" : undefined}>1 · {t("Features")}</li>
          {features.s3 && <li aria-current={step === "provider" ? "step" : undefined}>2 · {t("Storage provider")}</li>}
          <li aria-current={step === "mini" ? "step" : undefined}>{features.s3 ? "3" : "2"} · {t("Mini")}</li>
        </ol>
        <h1 id="onboarding-title">{step === "features" ? t("What would you like to use?") : step === "provider" ? t("Choose your storage provider") : t("Mini")}</h1>
        <p className="onboarding-note">{step === "features" ? t("Choose one or both. You can add S3 storage later in Settings.") : step === "provider" ? t("Browse and upload files with one or more S3 profiles.") : t("Configure the menu bar capture shortcut. You can change this later in Settings.")}</p>
        {step === "features" ? (
          <div className="onboarding-cards" role="group" aria-label={t("Features")}>
            {([
              ["compression", ImageDown, t("Compress"), t("Compress images locally. No account needed.")],
              ["s3", Cloud, t("S3 storage"), t("Browse and upload files with one or more S3 profiles.")],
            ] as const).map(([id, Icon, title, description]) => (
              <label key={id} className="onboarding-card" data-selected={features[id]}>
                <input type="checkbox" checked={features[id]} disabled={saving || connecting} onChange={(event) => { setFeatures({ ...features, [id]: event.target.checked }); setError(undefined); }} />
                <Icon size={30} aria-hidden="true" />
                <strong>{title}</strong><span>{description}</span>
              </label>
            ))}
          </div>
        ) : step === "provider" ? (
          <>
            <div className="onboarding-cards" role="radiogroup" aria-label={t("Storage provider")}>
              {([ ["r2", t("Cloudflare R2"), t("Connect with your Cloudflare account.")], ["other", t("Other S3-compatible storage"), t("Use your provider’s S3 credentials.")] ] as const).map(([id, title, description]) => (
                <label key={id} className="onboarding-card" data-selected={provider === id}>
                  <input type="radio" name="provider" checked={provider === id} disabled={saving || connecting} onChange={() => setProvider(id)} />
                  <Cloud size={30} aria-hidden="true" /><strong>{title}</strong><span>{description}</span>
                </label>
              ))}
            </div>
            {provider === "r2" ? <R2Connect onConnected={setConnectedSettings} onBusyChange={setConnecting} /> : <div className="onboarding-provider-note" role="status">
              <h2>{t("Configure S3 later")}</h2>
              <p>{t("This provider needs manual configuration. Finish setup now, then add one or more S3 profiles in Settings.")}</p>
            </div>}
          </>
        ) : <MiniPreferences value={mini} onChange={setMini} profiles={connectedSettings.profiles} disabled={saving} />}
        {step === "features" && !features.compression && !features.s3 && <p role="status" className="field-error">{t("Choose at least one feature.")}</p>}
        {error && <p role="alert" className="field-error">{error}</p>}
        <footer className="onboarding-actions">
          {step !== "features" && <Button variant="ghost" disabled={saving || connecting} onClick={() => { setStep(step === "mini" ? (features.s3 ? "provider" : "features") : "features"); setError(undefined); }}>{t("Back")}</Button>}
          <Button variant={skipR2 ? "outline" : "default"} disabled={saving || connecting || (step === "features" && !features.compression && !features.s3) || (step === "mini" && !miniSettingsValid(mini, connectedSettings.profiles))} onClick={() => {
            if (step === "features") setStep(features.s3 ? "provider" : "mini");
            else if (step === "provider") setStep("mini");
            else void complete();
          }}>
            {saving ? t("Saving...") : step === "mini" ? t("Complete setup") : step === "provider" && skipR2 ? t("Configure S3 later") : t("Continue")}
            {step === "mini" ? <Check aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
          </Button>
        </footer>
      </section>
    </main>
  );
}
