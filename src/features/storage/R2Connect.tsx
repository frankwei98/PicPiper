import { useEffect, useRef, useState } from "react";
import { t, useLocale } from "@/i18n";
import { r2Api, type AppSettings, type R2Account, type R2Bucket } from "@/api/backend";
import { openUrl } from "@/platform/desktop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/error";
import { PreferenceRow } from "@/components/ui/preference-row";

interface Props { onConnected: (settings: AppSettings) => void; onBusyChange?: (busy: boolean) => void; disabled?: boolean }

export function R2Connect({ onConnected, onBusyChange, disabled = false }: Props) {
  useLocale();
  const [sessionId, setSessionId] = useState("");
  const sessionRef = useRef("");
  const generation = useRef(0);
  const mounted = useRef(true);
  const [stage, setStage] = useState<"idle" | "waiting" | "choose" | "done">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [accounts, setAccounts] = useState<R2Account[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [jurisdiction, setJurisdiction] = useState("default");
  const [buckets, setBuckets] = useState<R2Bucket[]>([]);
  const [loadingBuckets, setLoadingBuckets] = useState(false);
  const [publicBaseUrls, setPublicBaseUrls] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [loadedScope, setLoadedScope] = useState("");
  const [importedCount, setImportedCount] = useState(0);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      if (sessionRef.current) void r2Api.cancel(sessionRef.current).catch(() => {});
    };
  }, []);
  const cancel = () => {
    generation.current += 1;
    if (sessionRef.current) void r2Api.cancel(sessionRef.current).catch(() => {});
    sessionRef.current = "";
    setSessionId(""); setStage("idle"); setError(undefined); setBusy(false);
    setLoadingAccounts(false); setLoadingBuckets(false);
    setPublicBaseUrls({});
    setAccounts([]); setAccountId(""); setBuckets([]); setSelected([]); setLoadedScope("");
  };
  const start = async () => {
    const attempt = ++generation.current;
    setBusy(true); setError(undefined);
    try {
      const session = await r2Api.start();
      if (!mounted.current || attempt !== generation.current) { void r2Api.cancel(session.sessionId).catch(() => {}); return; }
      sessionRef.current = session.sessionId;
      await openUrl(session.authorizationUrl);
      if (!mounted.current || attempt !== generation.current) return;
      setSessionId(session.sessionId); setStage("waiting");
    } catch (cause) {
      if (!mounted.current || attempt !== generation.current) return;
      if (sessionRef.current) void r2Api.cancel(sessionRef.current).catch(() => {});
      sessionRef.current = "";
      setError(errorMessage(cause, t("Could not connect to Cloudflare.")));
    } finally { if (mounted.current && attempt === generation.current) setBusy(false); }
  };
  useEffect(() => {
    if (!sessionId || stage !== "waiting") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await r2Api.poll(sessionId);
        if (stopped) return;
        if (result.status === "authorized") {
          setStage("choose");
          // Account discovery can require additional permissions. Manual ID entry
          // still uses the user's OAuth grant to discover the permitted buckets.
          const attempt = generation.current;
          setBusy(true);
          setLoadingAccounts(true);
          try {
            const found = await r2Api.accounts(sessionId);
            if (!mounted.current || attempt !== generation.current) return;
            setAccounts(found); if (found.length) setAccountId(found[0].id);
          } catch {
            if (mounted.current && attempt === generation.current) setError(t("Account discovery is unavailable. Enter your Cloudflare account ID to continue."));
          } finally { if (mounted.current && attempt === generation.current) { setBusy(false); setLoadingAccounts(false); } }
          return;
        }
        if (["failed", "expired", "closed"].includes(result.status)) {
          setError(result.message || t("Cloudflare sign-in expired. Please try again."));
          setStage("idle"); return;
        }
        timer = setTimeout(() => { void poll(); }, 1000);
      } catch (cause) {
        if (stopped) return;
        setError(errorMessage(cause, t("Could not connect to Cloudflare."))); setStage("idle");
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [sessionId, stage]);
  const loadBuckets = async () => {
    const attempt = generation.current;
    setLoadingBuckets(true);
    setBusy(true); setError(undefined); setSelected([]); setBuckets([]); setLoadedScope(""); setPublicBaseUrls({});
    try {
      const found = await r2Api.buckets({ sessionId, accountId: accountId.trim(), jurisdiction });
      if (mounted.current && attempt === generation.current) { setBuckets(found); setLoadedScope(`${accountId.trim()}:${jurisdiction}`); }
    } catch (cause) { if (mounted.current && attempt === generation.current) setError(errorMessage(cause, t("Could not load R2 buckets."))); }
    finally { if (mounted.current && attempt === generation.current) { setBusy(false); setLoadingBuckets(false); } }
  };
  const connect = async () => {
    const attempt = generation.current;
    setBusy(true); setError(undefined);
    try {
      const urls = Object.fromEntries(selected.map((name) => [name, (publicBaseUrls[name] ?? "").trim()]).filter(([, value]) => value && value !== "https://"));
      const settings = await r2Api.connect({ sessionId, accountId: accountId.trim(), jurisdiction, buckets: selected, ...(Object.keys(urls).length ? { publicBaseUrls: urls } : {}) });
      if (!mounted.current || attempt !== generation.current) return;
      onConnected(settings); setImportedCount(selected.length); setStage("done");
      void r2Api.cancel(sessionId).catch(() => {});
      sessionRef.current = ""; setSessionId("");
    } catch (cause) { if (mounted.current && attempt === generation.current) setError(errorMessage(cause, t("Could not save R2 profiles."))); }
    finally { if (mounted.current && attempt === generation.current) setBusy(false); }
  };
  const scopeMatches = loadedScope === `${accountId.trim()}:${jurisdiction}`;
  return <section className="r2-connect" aria-label={t("Connect Cloudflare R2")} aria-busy={busy}>
    <PreferenceRow label={<h3>Cloudflare R2</h3>} description={stage === "idle" ? t("Sign in in your browser, then choose the buckets to add. Only the selected buckets receive S3 credentials.") : undefined}>
      {stage === "idle" && <Button type="button" disabled={busy || disabled} onClick={() => void start()}>{t("Sign in with Cloudflare")}</Button>}
      {stage !== "idle" && stage !== "done" && <Button type="button" variant="ghost" disabled={busy || disabled} onClick={cancel}>{t("Cancel")}</Button>}
      {stage === "done" && <Button type="button" variant="outline" onClick={cancel}>{t("Add another Cloudflare account")}</Button>}
    </PreferenceRow>
    {stage === "waiting" && <p className="field-hint" role="status">{t("Waiting for browser authorization...")}</p>}
    {stage === "choose" && <>
      <div className="r2-scope">
        <PreferenceRow label={t("Cloudflare account ID")} htmlFor="r2-account">
          <div className="r2-account-control" aria-busy={loadingAccounts}>
            {loadingAccounts ? <Skeleton className="h-9 w-full" aria-hidden="true" /> : accounts.length ? <NativeSelect id="r2-account" aria-label={t("Cloudflare account ID")} value={accountId} disabled={busy || disabled} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((account) => <NativeSelectOption key={account.id} value={account.id}>{account.name || account.id}</NativeSelectOption>)}</NativeSelect> : <Input id="r2-account" aria-label={t("Cloudflare account ID")} value={accountId} disabled={busy || disabled} onChange={(event) => setAccountId(event.target.value)} />}
          </div>
        </PreferenceRow>
        <PreferenceRow label={t("R2 jurisdiction")} htmlFor="r2-jurisdiction"><NativeSelect id="r2-jurisdiction" aria-label={t("R2 jurisdiction")} value={jurisdiction} disabled={busy || disabled} onChange={(event) => setJurisdiction(event.target.value)}>
          <NativeSelectOption value="default">{t("Default")}</NativeSelectOption>
          <NativeSelectOption value="eu">EU</NativeSelectOption><NativeSelectOption value="us">US</NativeSelectOption><NativeSelectOption value="fedramp">FedRAMP</NativeSelectOption>
        </NativeSelect></PreferenceRow>
      </div>
      <div className="r2-actions"><Button type="button" variant="outline" disabled={busy || disabled || !/^[a-f\d]{32}$/i.test(accountId.trim())} onClick={() => void loadBuckets()}>{t("Load buckets")}</Button></div>
      {(scopeMatches || loadingBuckets) && <fieldset className="r2-buckets" aria-busy={loadingBuckets}><legend>{t("Choose buckets")}</legend>
        {loadingBuckets ? <div className="space-y-3">
          <Skeleton className="h-5 w-2/3" aria-hidden="true" />
          <Skeleton className="h-5 w-1/2" aria-hidden="true" />
          <Skeleton className="h-5 w-3/5" aria-hidden="true" />
        </div> : buckets.length === 0 && <p>{t("No buckets found in this account and jurisdiction.")}</p>}
        {buckets.map((bucket) => <div key={bucket.name} className="r2-bucket">
          <label><input type="checkbox" checked={selected.includes(bucket.name)} disabled={busy || disabled} onChange={(event) => setSelected((current) => event.target.checked ? [...current, bucket.name] : current.filter((name) => name !== bucket.name))} />{bucket.name}</label>
          {selected.includes(bucket.name) && <div className="field">
            <Label htmlFor={`r2-public-${bucket.name}`}>{t("Public Base URL for {{bucket}}", { bucket: bucket.name })}</Label>
            <Input id={`r2-public-${bucket.name}`} type="url" value={publicBaseUrls[bucket.name] ?? "https://"} placeholder="https://cdn.example.com" disabled={busy || disabled} onChange={(event) => setPublicBaseUrls((current) => ({ ...current, [bucket.name]: event.target.value }))} />
            <p className="field-hint">{t("Optional. Used for image previews and public links.")}</p>
          </div>}
        </div>)}
      </fieldset>}
      <p className="field-hint">{t("Credentials are stored locally on this device as private files with restricted permissions. Not synced or encrypted.")}</p>
      <div className="r2-actions"><Button type="button" disabled={busy || disabled || !scopeMatches || !selected.length || selected.length > 50} onClick={() => void connect()}>{busy ? t("Saving...") : t("Add selected buckets")}</Button></div>
    </>}
    {stage === "done" && <p className="field-hint" role="status">{t("Added {{count}} R2 profile(s).", { count: importedCount })}</p>}
    {error && <p role="alert" className="field-error">{error}</p>}
  </section>;
}
