import { useState } from "react";
import { t, useLocale } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ImageWithSkeleton } from "@/components/ImageWithSkeleton";
import type { OptimizeItem, S3Profile } from "../../types";
import { formatBytes } from "./optimizeQueue";

interface Props {
  open: boolean;
  items: OptimizeItem[];
  locked: boolean;
  profiles: S3Profile[];
  profileId?: string;
  onProfile: (id: string) => void;
  onClose: () => void;
  onSave: (ids: string[]) => void;
  onCopy: (ids: string[]) => void;
  onUpload: (ids: string[]) => void;
  onCompare: (id: string) => void;
  message: string | null;
  error: string | null;
}

export function CompressionResults(props: Props) {
  useLocale();
  const [selected, setSelected] = useState(() => new Set(props.items.map((item) => item.id)));
  const [currentId, setCurrentId] = useState(props.items[0]?.id);
  const current = props.items.find((item) => item.id === currentId) ?? props.items[0];
  const ids = props.items.filter((item) => selected.has(item.id)).map((item) => item.id);
  const actions = (itemIds: string[], batch: boolean) => <div className="flex flex-wrap gap-2">
    <Button variant="outline" disabled={props.locked || !itemIds.length} onClick={() => props.onCopy(itemIds)}>{t(batch ? "Copy selected images" : "Copy image")}</Button>
    <Button variant="outline" disabled={props.locked || !itemIds.length} onClick={() => props.onSave(itemIds)}>{t(batch ? "Save selected images" : "Save image")}</Button>
    <Button disabled={props.locked || !itemIds.length || !props.profileId} onClick={() => props.onUpload(itemIds)}>{t(batch ? "Upload selected" : "S3 upload")}</Button>
  </div>;
  return <Dialog open={props.open} onOpenChange={(open) => { if (!open && !props.locked) props.onClose(); }}>
    <DialogContent className="sm:max-w-5xl max-h-[90dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>{t("Compression results")}</DialogTitle><DialogDescription>{t("Preview compressed images, then copy, save or upload your selection.")}</DialogDescription></DialogHeader>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={t("Select all recent results")} checked={ids.length === props.items.length} ref={(node) => { if (node) node.indeterminate = ids.length > 0 && ids.length < props.items.length; }} onChange={(event) => setSelected(event.target.checked ? new Set(props.items.map((item) => item.id)) : new Set())} />{t("Selected {{count}}", { count: ids.length })}</label>
        {props.profiles.length > 0 && <select aria-label={t("Upload destination")} value={props.profileId} disabled={props.locked} onChange={(event) => props.onProfile(event.target.value)}>{props.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} / {profile.bucket}</option>)}</select>}
        {actions(ids, true)}
      </div>
      {props.profiles.length === 0 && <p className="text-sm text-muted-foreground">{t("Set an upload destination in Settings. Your compressed images will stay here.")}</p>}
      <p className="text-xs text-muted-foreground">{t("One image copies pixels; multiple images copy files for pasting into Finder or compatible apps.")}</p>
      <div className="grid gap-4 sm:grid-cols-[220px_1fr] min-h-0">
        <div className="max-h-[50dvh] overflow-y-auto space-y-2" aria-label={t("Recent results")}>
          {props.items.map((item) => <div key={item.id} className="flex items-center gap-2 rounded-md border p-2">
            <input type="checkbox" aria-label={t("Select {{name}}", { name: item.outputFileName ?? item.fileName })} checked={selected.has(item.id)} onChange={(event) => setSelected((previous) => { const next = new Set(previous); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })} />
            <button className="flex min-w-0 items-center gap-2 text-left" aria-pressed={current?.id === item.id} onClick={() => setCurrentId(item.id)}>
              <img className="size-12 object-contain" src={item.compressedPreviewUrl} alt="" /><span className="truncate text-sm">{item.outputFileName ?? item.fileName}</span>
            </button>
          </div>)}
        </div>
        {current && <section className="min-w-0 space-y-3" aria-label={t("Image preview")}>
          <div className="grid h-[40dvh] place-items-center overflow-hidden rounded-md bg-muted"><ImageWithSkeleton className="max-h-[40dvh] max-w-full object-contain" src={current.compressedPreviewUrl!} alt={t("Compressed preview of {{filename}}", { filename: current.fileName })} /></div>
          <p className="text-sm break-all">{current.outputFileName} · {formatBytes(current.originalBytes)} → {formatBytes(current.outputBytes ?? 0)}</p>
          <div className="flex flex-wrap gap-2">{actions([current.id], false)}<Button variant="ghost" onClick={() => props.onCompare(current.id)}>{t("Compare")}</Button></div>
        </section>}
      </div>
      {props.message && <p role="status" className="text-sm">{props.message}</p>}
      {props.error && <p role="alert" className="text-sm text-destructive">{props.error}</p>}
      <Button variant="outline" disabled={props.locked} onClick={props.onClose}>{t("Back to compression")}</Button>
    </DialogContent>
  </Dialog>;
}
