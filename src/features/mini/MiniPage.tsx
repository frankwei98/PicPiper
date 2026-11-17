import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, Clock3, CloudUpload, Copy, ExternalLink, ImageDown, Images, Link, LoaderCircle, RefreshCw, X } from "lucide-react";
import { defaultMiniSettings, miniApi, settingsApi, type MiniCompressionChanges, type MiniItem, type MiniSettings, type MiniState } from "@/api/backend";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { open, onFileDrop } from "@/platform/desktop";
import { errorMessage } from "@/lib/error";
import { extensionsFor, writableImageFormats } from "@/lib/imageFormats";
import { t, useLocale, type MessageKey } from "@/i18n";
import { MiniUploadDialog } from "./MiniUploadDialog";
import logo from "../../../resources/logo-ui.png";
import "./mini.css";

const statusLabels: Record<string, MessageKey> = { queued: "Queued", compressing: "Compressing...", uploading: "Uploading...", failed: "Failed" };
const bytes = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`;
const ready = (item: MiniItem) => item.status === "completed" && item.uploadStatus !== "queued" && item.uploadStatus !== "uploading";
const formats = writableImageFormats().filter((format) => format !== "jxl");

export function MiniPage() {
  useLocale();
  const [loaded, setLoaded] = useState(false);
  const [config, setConfig] = useState<MiniSettings>(defaultMiniSettings);
  const [draft, setDraft] = useState<MiniSettings>(defaultMiniSettings);
  const [state, setState] = useState<MiniState>({ items: [], busy: false, copied: "", error: "" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploadIds, setUploadIds] = useState<string[] | null>(null);
  const [compressionOpen, setCompressionOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copying, setCopying] = useState<string>();
  const [clearing, setClearing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<{ message: MessageKey; values?: Record<string, string | number>; undo?: boolean }>();
  const alive = useRef(true);
  const stateVersion = useRef(0);
  const configVersion = useRef(0);
  const compressionBase = useRef<MiniSettings>(defaultMiniSettings);

  useEffect(() => {
    alive.current = true;
    const loadConfig = async () => {
      const version = ++configVersion.current;
      try {
        const settings = await settingsApi.loadSettings();
        if (alive.current && version === configVersion.current) {
          setConfig({ ...(settings.mini ?? defaultMiniSettings), action: "clipboard" });
          setLoaded(true);
        }
      } catch (cause) {
        if (alive.current && version === configVersion.current) setError(errorMessage(cause, t("Failed to load settings.")));
      }
    };
    void loadConfig();
    const offSettings = settingsApi.onChanged?.(() => { void loadConfig(); });
    let running = false;
    const poll = async () => {
      if (running) return;
      running = true;
      const version = stateVersion.current;
      try { const snapshot = await miniApi.state(); if (alive.current && version === stateVersion.current) setState(snapshot); }
      catch (cause) { if (alive.current && version === stateVersion.current) setError(errorMessage(cause, t("Mini could not load its queue."))); }
      finally { running = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 500);
    return () => { alive.current = false; configVersion.current++; offSettings?.(); window.clearInterval(timer); };
  }, []);

  const update = async (action: () => Promise<MiniState>) => {
    stateVersion.current++;
    const snapshot = await action();
    if (alive.current) { stateVersion.current++; setState(snapshot); }
    return snapshot;
  };
  const add = async (paths: string[]) => {
    if (!paths.length) return;
    setError("");
    try { await update(() => miniApi.add(paths)); }
    catch (cause) { if (alive.current) setError(errorMessage(cause, t("Mini could not process these images."))); }
  };
  useEffect(() => onFileDrop((paths) => { void add(paths); }), []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !uploadIds && !compressionOpen) { event.preventDefault(); void miniApi.window("close"); } };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [uploadIds, compressionOpen]);
  useEffect(() => {
    const available = new Set(state.items.filter(ready).map((item) => item.id));
    setSelected((current) => {
      const remaining = new Set([...current].filter((id) => available.has(id)));
      return remaining.size === current.size ? current : remaining;
    });
  }, [state.items]);
  useEffect(() => {
    if (state.copied) setToast({ message: state.copied === "image" ? "Image copied to clipboard" : "Links copied to clipboard" });
  }, [state.copied, state.copySequence]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), toast.undo ? 6500 : 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const saveCompression = async () => {
    if (saving) return;
    setSaving(true); setError("");
    const changes: MiniCompressionChanges = {};
    if (draft.targetFormat !== compressionBase.current.targetFormat) changes.targetFormat = draft.targetFormat;
    if (draft.quality !== compressionBase.current.quality) changes.quality = draft.quality;
    const version = ++configVersion.current;
    try {
      const next = await miniApi.saveCompression(changes);
      if (alive.current) {
        if (version === configVersion.current) setConfig(next);
        setCompressionOpen(false);
      }
    }
    catch (cause) { if (alive.current) setError(errorMessage(cause, t("Failed to save Mini settings."))); }
    finally { if (alive.current) setSaving(false); }
  };
  const upload = async (ids: string[], profileId: string, linkFormat: MiniSettings["linkFormat"], bucketKey: string) => {
    await update(() => miniApi.upload(ids, profileId, linkFormat, bucketKey));
    if (alive.current) { setConfig((current) => ({ ...current, profileId, linkFormat })); setUploadIds(null); setSelected(new Set()); }
  };
  const copy = async (item: MiniItem, image: boolean) => {
    setCopying(`${image ? "image" : "link"}-${item.id}`); setError("");
    try {
      await update(async () => { if (image) await miniApi.copyImage(item.id); else await miniApi.copy(item.id, item.linkFormat ?? config.linkFormat); return miniApi.state(); });
    } catch (cause) { if (alive.current) setError(errorMessage(cause, t("Could not copy the result."))); }
    finally { if (alive.current) setCopying(undefined); }
  };
  const exportImages = async (ids: string[]) => {
    if (!ids.length) return;
    setSaving(true); setError(""); setToast(undefined);
    try {
      const targetDir = await open({ directory: true });
      if (!targetDir) return;
      const copied = await miniApi.export(ids, String(targetDir));
      if (alive.current) setToast({ message: "Saved {{value0}} file(s) to {{value1}}", values: { value0: copied.length, value1: String(targetDir) } });
    } catch (cause) { if (alive.current) setError(errorMessage(cause, t("Failed to save files"))); }
    finally { if (alive.current) setSaving(false); }
  };
  const clear = async () => {
    setClearing(true); setError("");
    try { await update(() => miniApi.clear()); if (alive.current) { setSelected(new Set()); setToast({ message: "List cleared", undo: true }); } }
    catch (cause) { if (alive.current) setError(errorMessage(cause, t("Failed to clear Mini results."))); }
    finally { if (alive.current) setClearing(false); }
  };
  const restore = async () => {
    setClearing(true); setError("");
    try { await update(() => miniApi.restore()); if (alive.current) setToast({ message: "Records restored" }); }
    catch (cause) { if (alive.current) setError(errorMessage(cause, t("Failed to restore Mini results."))); }
    finally { if (alive.current) setClearing(false); }
  };
  const chooseFiles = async () => {
    try { const paths = await open({ multiple: true, filters: [{ name: t("Images"), extensions: extensionsFor("compressImport") }] }); if (paths) await add(typeof paths === "string" ? [paths] : paths); }
    catch (cause) { if (alive.current) setError(errorMessage(cause, t("Could not choose images."))); }
  };
  const available = state.items.filter(ready);
  const uploadItems = uploadIds ? state.items.filter((item) => uploadIds.includes(item.id) && ready(item)) : [];
  const openUpload = (ids: string[]) => { setToast(undefined); setError(""); setUploadIds(ids); };
  const setChecked = (id: string, checked: boolean) => setSelected((current) => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; });

  return <main className="mini-surface" aria-label={t("Pic Piper Mini")}>
    <header className="mini-header">
      <img src={logo} alt="" className="mini-logo" /><strong>Pic Piper</strong>
      <button className="mini-format" aria-label={t("Adjust compression settings")} disabled={!loaded} onClick={() => { compressionBase.current = config; setDraft(config); setToast(undefined); setError(""); setCompressionOpen(true); }}>{config.targetFormat.toUpperCase()}<span>·</span>{config.quality}%<ChevronDown /></button>
      <div className="mini-window-actions"><button aria-label={t("Open full window")} onClick={() => void miniApi.window("main")}><ExternalLink /></button><button aria-label={t("Close Mini")} onClick={() => void miniApi.window("close")}><X /></button></div>
    </header>
    <button className={`mini-drop ${dragging ? "is-dragging" : ""}`} data-testid="mini-drop-zone" disabled={!loaded || !config.enabled} onClick={() => void chooseFiles()} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={() => setDragging(false)}><ImageDown /><strong>{dragging ? t("Drop to start") : state.items.length ? t("Drop more images") : t("Drop images to compress")}</strong><span>{t("Or click to choose images")}</span></button>
    <section className="mini-results" aria-label={t("Mini results")}>
      <div className="mini-results-head">
        <input type="checkbox" aria-label={t("Select all recent results")} checked={available.length > 0 && selected.size === available.length} disabled={!available.length} ref={(node) => { if (node) node.indeterminate = selected.size > 0 && selected.size < available.length; }} onChange={(event) => setSelected(event.target.checked ? new Set(available.map((item) => item.id)) : new Set())} />
        <strong>{t("Recent results")}</strong><span>{selected.size ? t("Selected {{count}}", { count: selected.size }) : state.items.length}</span>
        <div className="mini-list-actions">{selected.size > 0 && <><button className="mini-selected-upload" aria-label={t("Save to local folder")} title={t("Save selected images")} disabled={saving} onClick={() => void exportImages([...selected])}><ImageDown /></button><button className="mini-selected-upload" aria-label={t("Upload selected")} disabled={state.busy} onClick={() => openUpload([...selected])}><CloudUpload />{t("Upload")}</button></>}<button className="mini-clear" disabled={!state.items.length || clearing} title={t("Only hides Mini records. Images and S3 history are kept.")} onClick={() => void clear()}>{t("Clear list")}</button></div>
      </div>
      <div className="mini-results-scroll" data-testid="mini-results-scroll">
        {!state.items.length && <div className="mini-empty"><Images /><strong>{t("No recent images")}</strong><span>{t("Drop images to compress and copy")}</span></div>}
        {state.items.map((item) => {
          const uploaded = Boolean(item.url) || Object.keys(item.uploads ?? {}).length > 0;
          const pending = item.uploadStatus === "queued" || item.uploadStatus === "uploading";
          return <article className={`mini-item ${selected.has(item.id) ? "is-selected" : ""}`} key={item.id}>
            <input type="checkbox" aria-label={t("Select {{name}}", { name: item.outputName || item.name })} checked={selected.has(item.id)} disabled={!ready(item)} onChange={(event) => setChecked(item.id, event.target.checked)} />
            {item.thumbnail ? <img src={item.thumbnail} alt="" /> : <span className="mini-thumb"><ImageDown /></span>}
            <div className="mini-item-info"><strong title={item.outputName || item.name}>{item.outputName || item.name}</strong><span>{pending ? t("Uploading...") : item.status === "completed" ? `${bytes(item.originalBytes)} → ${bytes(item.outputBytes)}` : t(statusLabels[item.status] ?? "Processing images...")}</span>{item.error && <p className="mini-item-error">{item.error}</p>}{item.uploadError && <p className="mini-item-error">{item.uploadError}</p>}{item.warning && <p className="mini-item-warning">{item.warning}</p>}</div>
            {item.status === "completed" ? <div className="mini-item-actions">
              <button aria-label={t("Copy image {{name}}", { name: item.outputName })} title={t("Copy image")} disabled={Boolean(copying)} onClick={() => void copy(item, true)}>{copying === `image-${item.id}` ? <LoaderCircle className="mini-spin" /> : <Copy />}</button>
              <button aria-label={`${t("Save to local folder")}: ${item.outputName}`} title={t("Save to local folder")} disabled={saving || !ready(item)} onClick={() => void exportImages([item.id])}><ImageDown /></button>
              {item.url && <button aria-label={t("Copy link {{name}}", { name: item.outputName })} title={t("Copy link")} disabled={Boolean(copying)} onClick={() => void copy(item, false)}><Link /></button>}
              <button className={uploaded ? "mini-uploaded" : undefined} aria-label={t("Upload {{name}} to S3", { name: item.outputName })} title={uploaded ? t("Uploaded before; choose another bucket") : t("S3 upload")} disabled={state.busy || pending} onClick={() => openUpload([item.id])}>{pending ? <LoaderCircle className="mini-spin" /> : <span className="mini-upload-icon"><CloudUpload />{uploaded && <span className="mini-upload-refresh"><RefreshCw /></span>}</span>}</button>
            </div> : item.status !== "failed" && <LoaderCircle className="mini-spin" />}
          </article>;
        })}
        {(error || state.error) && !compressionOpen && <p className="mini-error" role="alert">{error || state.error}</p>}
      </div>
    </section>
    <footer className="mini-retention" title={t("Only hides Mini records. Images and S3 history are kept.")}><Clock3 />{t("Completed results hide automatically after 12 hours")}</footer>
    {toast && <div className="mini-toast" role="status"><CheckCircle2 /><span>{t(toast.message, toast.values)}</span>{toast.undo && state.canUndoClear && <button disabled={clearing} onClick={() => void restore()}>{t("Undo")}</button>}</div>}
    {uploadIds && <MiniUploadDialog items={uploadItems} initialProfileId={config.profileId} initialLinkFormat={config.linkFormat} onClose={() => setUploadIds(null)} onUpload={upload} />}
    <Dialog open={compressionOpen} onOpenChange={(next) => { if (!saving) setCompressionOpen(next); }}><DialogContent className="mini-dialog mini-compression-dialog"><DialogTitle>{t("Compression settings")}</DialogTitle><DialogDescription className="sr-only">{t("Adjust compression settings")}</DialogDescription><div className="mini-compression-fields"><label className="mini-dialog-field"><span>{t("Image format")}</span><select aria-label={t("Image format")} value={draft.targetFormat} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, targetFormat: event.target.value as MiniSettings["targetFormat"] }))}>{formats.map((format) => <option key={format} value={format}>{format.toUpperCase()}</option>)}</select></label><label className="mini-dialog-field"><span>{t("Quality")}</span><input aria-label={t("Quality")} type="number" min={1} max={100} value={draft.quality} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, quality: Math.max(1, Math.min(100, Math.round(Number(event.target.value) || 90))) }))} /></label></div>{error && <p className="mini-item-error" role="alert">{error}</p>}<div className="mini-dialog-actions"><button disabled={saving} onClick={() => setCompressionOpen(false)}>{t("Cancel")}</button><button className="mini-primary" disabled={saving} onClick={() => void saveCompression()}>{t("Save Mini settings")}</button></div></DialogContent></Dialog>
  </main>;
}
