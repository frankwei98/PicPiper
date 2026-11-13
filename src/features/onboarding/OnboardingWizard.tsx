import { R2Connect } from "@/features/storage/R2Connect";
import { useState } from "react";
import { Cloud, ImageDown, ArrowRight, Check } from "lucide-react";
import { t, useLocale } from "@/i18n";
import { Button } from "@/components/ui/button";
import type { AppSettings } from "@/api/backend";
import { settingsApi } from "@/api/backend";
import { errorMessage } from "@/lib/error";

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
  const [step, setStep] = useState<"features" | "provider">("features");
  const [provider, setProvider] = useState<"r2" | "other">("r2");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const complete = async () => {
    setSaving(true);
    setError(undefined);
    const next = { ...connectedSettings, onboardingCompleted: true, features };
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
        <p className="onboarding-eyebrow">{t("Welcome to Pic Piper")}</p>
        <ol className="onboarding-steps" aria-label={t("Welcome to Pic Piper")}>
          <li aria-current={step === "features" ? "step" : undefined}>1 · {t("Features")}</li>
          {features.s3 && <li aria-current={step === "provider" ? "step" : undefined}>2 · {t("Storage provider")}</li>}
        </ol>
        <h1 id="onboarding-title">{step === "features" ? t("What would you like to use?") : t("Choose your storage provider")}</h1>
        <p className="onboarding-note">{step === "features" ? t("Choose one or both. You can add S3 storage later in Settings.") : t("Browse and upload files with one or more S3 profiles.")}</p>
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
        ) : (
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
        )}
        {!features.compression && !features.s3 && <p role="status" className="field-error">{t("Choose at least one feature.")}</p>}
        {error && <p role="alert" className="field-error">{error}</p>}
        <footer className="onboarding-actions">
          {step === "provider" && <Button variant="ghost" disabled={saving || connecting} onClick={() => { setStep("features"); setError(undefined); }}>{t("Back")}</Button>}
          <Button variant={skipR2 ? "outline" : "default"} disabled={saving || connecting || (!features.compression && !features.s3)} onClick={() => {
            if (step === "features" && features.s3) setStep("provider");
            else void complete();
          }}>
            {saving ? t("Saving...") : step === "features" && features.s3 ? t("Continue") : skipR2 ? t("Configure S3 later") : t("Get started")}
            {step === "features" && features.s3 ? <ArrowRight aria-hidden="true" /> : <Check aria-hidden="true" />}
          </Button>
        </footer>
      </section>
    </main>
  );
}
