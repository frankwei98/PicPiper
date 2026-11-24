import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PreferenceRow } from "@/components/ui/preference-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { getLocale, t, useLocale } from "@/i18n";
import { errorMessage } from "@/lib/error";
import { useCallback, useEffect, useRef, useState } from "react";
import { updateApi, type UpdateState } from "@/api/updates";

export function UpdatePreferences({ isActive = true }: { isActive?: boolean }) {
  useLocale();
  const [state, setState] = useState<UpdateState | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const fetchGeneration = useRef(0);
  const savingRef = useRef(false);

  const refresh = useCallback(async (requestGeneration: number, reportError = false) => {
    const requestId = ++fetchGeneration.current;
    try {
      const next = await updateApi.state();
      if (generation.current !== requestGeneration || fetchGeneration.current !== requestId) return;
      setState(next);
      if (reportError) setError(null);
    } catch (cause) {
      if (generation.current !== requestGeneration || fetchGeneration.current !== requestId || !reportError) return;
      setError(errorMessage(cause, t("Could not check for updates.")));
    } finally {
      if (generation.current === requestGeneration && fetchGeneration.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    const requestGeneration = ++generation.current;
    setLoading(true);
    setChecking(false);
    setSaving(false);
    void refresh(requestGeneration, true);
    const unsubscribe = updateApi.subscribe(() => {
      if (generation.current !== requestGeneration || savingRef.current) return;
      void refresh(requestGeneration);
    });
    return () => {
      generation.current += 1;
      fetchGeneration.current += 1;
      savingRef.current = false;
      unsubscribe();
    };
  }, [isActive, refresh]);

  const checkForUpdates = async () => {
    setError(null);
    setChecking(true);
    const requestGeneration = generation.current;
    try {
      await updateApi.check();
      if (generation.current !== requestGeneration) return;
      await refresh(requestGeneration, true);
    } catch (cause) {
      if (generation.current !== requestGeneration) return;
      setError(errorMessage(cause, t("Could not check for updates.")));
    } finally {
      if (generation.current === requestGeneration) setChecking(false);
    }
  };

  const savePreferences = async (automaticChecks: boolean, automaticDownloads: boolean) => {
    if (!state || loading || checking || savingRef.current) return;
    const previous = state;
    savingRef.current = true;
    ++fetchGeneration.current;
    setSaving(true);
    setError(null);
    setState({ ...previous, automaticChecks, automaticDownloads });
    const requestGeneration = generation.current;
    try {
      const next = await updateApi.preferences({ automaticChecks, automaticDownloads });
      if (generation.current === requestGeneration) setState(next);
    } catch (cause) {
      if (generation.current === requestGeneration) {
        setState(previous);
        setError(errorMessage(cause, t("Could not save update preferences.")));
      }
    } finally {
      if (generation.current === requestGeneration) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };

  const formatLastCheck = (value: string) => {
    if (!value) return t("Not checked yet");
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    try {
      return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(date);
    } catch {
      return date.toLocaleString();
    }
  };

  const canUseUpdater = state?.enabled ?? false;
  const updaterBusy = loading || checking || saving;

  return <section className="settings-group settings-preferences">
    <h3>{t("Updates")}</h3>
    <PreferenceRow label={state ? t("Version {{version}}", { version: state.version }) : <><span className="sr-only">{t("Version")}</span><Skeleton className="h-4 w-24" aria-hidden="true" /></>}>
      <Button type="button" variant="outline" disabled={(state !== null && !canUseUpdater) || updaterBusy} onClick={checkForUpdates}>
        {loading || checking ? t("Checking...") : t("Check for updates")}
      </Button>
    </PreferenceRow>
    {!canUseUpdater && <p className="field-hint">{t("Updates are available in an installed release build.")}</p>}
    <PreferenceRow label={t("Automatic update checks")} htmlFor="settings-automatic-update-checks" description={t("Checks periodically for new releases.")} descriptionId="settings-automatic-update-checks-description">
      <Switch id="settings-automatic-update-checks" aria-label={t("Automatic update checks")} aria-describedby="settings-automatic-update-checks-description" checked={state?.automaticChecks ?? false} disabled={!canUseUpdater || updaterBusy} onCheckedChange={(checked) => state && void savePreferences(checked, state.automaticDownloads)} />
    </PreferenceRow>
    <PreferenceRow label={t("Automatic update downloads")} htmlFor="settings-automatic-update-downloads" description={t("Downloads available updates automatically.")} descriptionId="settings-automatic-update-downloads-description">
      <Switch id="settings-automatic-update-downloads" aria-label={t("Automatic update downloads")} aria-describedby="settings-automatic-update-downloads-description" checked={state?.automaticDownloads ?? false} disabled={!canUseUpdater || updaterBusy} onCheckedChange={(checked) => state && void savePreferences(state.automaticChecks, checked)} />
    </PreferenceRow>
    <PreferenceRow label={t("Last checked")}>{state ? formatLastCheck(state.lastCheck) : "—"}</PreferenceRow>
    {state?.availableVersion && <PreferenceRow label={t("Available version")}>{state.availableVersion}</PreferenceRow>}
    {state?.restartDeferred && <p className="field-hint">{t("Finish your current tasks, then quit and reopen Pic Piper to use the update.")}</p>}
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
  </section>;
}
