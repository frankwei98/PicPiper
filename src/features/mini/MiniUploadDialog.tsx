import { useEffect, useState } from "react";
import { CloudUpload, Copy } from "lucide-react";
import { miniApi, type MiniItem, type MiniSettings, type MiniUploadTarget } from "@/api/backend";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/error";
import { t, type MessageKey } from "@/i18n";

const linkFormats: Array<[MiniSettings["linkFormat"], MessageKey]> = [["url", "Plain text URL"], ["html", "HTML"], ["bbcode", "BBCode"], ["markdown", "Markdown"]];

interface Props {
  items: MiniItem[];
  initialProfileId: string;
  initialLinkFormat: MiniSettings["linkFormat"];
  onClose: () => void;
  onUpload: (ids: string[], profileId: string, format: MiniSettings["linkFormat"]) => Promise<void>;
}

export function MiniUploadDialog({ items, initialProfileId, initialLinkFormat, onClose, onUpload }: Props) {
  const [targets, setTargets] = useState<MiniUploadTarget[]>([]);
  const [profileId, setProfileId] = useState(initialProfileId);
  const [linkFormat, setLinkFormat] = useState(initialLinkFormat);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void miniApi.targets().then((loaded) => {
      if (!active) return;
      setTargets(loaded);
      setProfileId((current) => loaded.some((target) => target.profileId === current) ? current : loaded[0]?.profileId ?? "");
    }).catch((cause) => { if (active) setError(errorMessage(cause, t("Failed to load upload destinations."))); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const target = targets.find((candidate) => candidate.profileId === profileId);
  const skipped = target ? items.filter((item) => item.uploads?.[target.bucketKey]).length : 0;
  const remaining = items.length - skipped;
  const allUploaded = Boolean(target) && remaining === 0 && items.length > 0;
  const confirm = async () => {
    if (!target || submitting || !items.length) return;
    setSubmitting(true); setError("");
    try { await onUpload(items.map((item) => item.id), target.profileId, linkFormat); }
    catch (cause) { setError(errorMessage(cause, t("Could not upload the result."))); setSubmitting(false); }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
    <DialogContent className="mini-dialog mini-upload-dialog">
      <DialogTitle className="mini-dialog-title"><CloudUpload />{items.length === 1 ? t("Upload image") : t("Upload {{count}} images", { count: items.length })}</DialogTitle>
      <DialogDescription className="mini-dialog-description">{items.length === 1 ? items[0].outputName : t("{{name}} and {{count}} more", { name: items[0]?.outputName ?? "", count: Math.max(0, items.length - 1) })}</DialogDescription>
      <label className="mini-dialog-field"><span>{t("Upload to")}</span><select aria-label={t("S3 profile")} value={profileId} disabled={loading || submitting || !targets.length} onChange={(event) => setProfileId(event.target.value)}>
        {!targets.length && <option value="">{loading ? t("Loading...") : t("No S3 upload destination")}</option>}
        {targets.map((candidate) => {
          const uploaded = items.filter((item) => item.uploads?.[candidate.bucketKey]).length;
          return <option key={candidate.profileId} value={candidate.profileId}>{candidate.name} / {candidate.bucket}{uploaded > 0 && ` · ${uploaded === items.length ? t("Already uploaded") : t("{{count}} already uploaded", { count: uploaded })}`}</option>;
        })}
      </select></label>
      <fieldset className="mini-dialog-links"><legend>{t("Link format")}</legend><div className="mini-segments mini-link-formats" role="group" aria-label={t("Link format")}>{linkFormats.map(([format, label]) => <button key={format} type="button" aria-pressed={linkFormat === format} disabled={submitting} onClick={() => setLinkFormat(format)}>{t(label)}</button>)}</div></fieldset>
      {!loading && !targets.length ? <p className="mini-dialog-hint">{t("Mini uploads need a profile with a Public Base URL.")}</p> : skipped > 0 && <p className="mini-dialog-hint">{allUploaded ? t("These images are already in this bucket. Existing links will be reused.") : t("Upload {{upload}} images; skip {{skip}} already in this bucket and reuse their links.", { upload: remaining, skip: skipped })}</p>}
      {error && <p className="mini-item-error" role="alert">{error}</p>}
      <div className="mini-dialog-actions"><button type="button" disabled={submitting} onClick={onClose}>{t("Cancel")}</button><button type="button" className="mini-primary" disabled={loading || submitting || !target || !items.length} onClick={() => void confirm()}>{allUploaded ? <Copy /> : <CloudUpload />}{submitting ? t("Uploading...") : allUploaded ? t("Copy existing links") : skipped > 0 ? t("Upload {{count}} and copy links", { count: remaining }) : t("Upload and copy links")}</button></div>
    </DialogContent>
  </Dialog>;
}
