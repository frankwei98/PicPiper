import { sortGalleryObjects, type GallerySort } from "./gallerySort";
import { EMPTY_GALLERY_FILTERS, filterGalleryObjects, type GalleryFilters } from "./galleryFilters";
import { Folder, LayoutGrid, List, Pencil, Search, SlidersHorizontal, X } from "lucide-react";
import { LazyRender } from "@/components/LazyRender";
import { GalleryCardSkeleton } from "./GalleryCardSkeleton";
import { GalleryThumbnail } from "./GalleryThumbnail";
import { t, useLocale } from "@/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, openUrl, writeClipboard } from "@/platform/desktop";
import type { GalleryObject, S3Profile } from "../../types";
import type { GalleryFocus } from "../../state/appState";
import type { AppView } from "../../types";
import { galleryApi, namingApi, uploadApi, type ListGalleryObjectsResponse } from "../../api/backend";
import { beginUpdateActivity } from "@/api/updates";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { fileNameFromPath } from "../../lib/path";
import { errorMessage } from "../../lib/error";
import { contentTypeForExtension, extensionsFor } from "../../lib/imageFormats";

interface S3GalleryPageProps {
  galleryFocus: GalleryFocus;
  profiles: S3Profile[];
  defaultProfileId?: string;
  namingTemplate?: string;
  onNavigate?: (view: AppView) => void;
}

interface GalleryScope {
  profile: S3Profile;
  prefix: string;
}

interface ScopedHighlights extends GalleryScope {
  keys: string[];
}

interface PendingGalleryLoad {
  profile: S3Profile;
  appendedUploads: Set<GalleryObject> | null;
  deletedUploads: GalleryObject[];
}

type ObjectAction =
  | { status: "pending"; kind: "delete" | "download"; key: string }
  | { status: "failed"; message: string };

function bucketIdentity(profile: S3Profile) {
  return JSON.stringify([profile.endpoint.replace(/\/+$/, ""), profile.bucket]);
}

function isSameBucket(profile: S3Profile, other?: S3Profile) {
  return other !== undefined && bucketIdentity(profile) === bucketIdentity(other);
}

function isSameScope(scope: GalleryScope | null, profile: S3Profile | undefined, prefix: string) {
  return scope !== null && scope.profile.id === profile?.id &&
    isSameBucket(scope.profile, profile) && scope.prefix === prefix;
}

function isSameUpload(object: GalleryObject, other: GalleryObject) {
  return object.key === other.key && (
    object.uploadId || other.uploadId
      ? object.uploadId === other.uploadId
      : object.uploadedAt === other.uploadedAt
  );
}

export function S3GalleryPage({ galleryFocus, profiles, defaultProfileId, namingTemplate: namingTemplateProp, onNavigate }: S3GalleryPageProps) {
  useLocale();
  const resolveDefaultId = () =>
    galleryFocus.profileId ?? defaultProfileId ?? profiles[0]?.id ?? "";
  const [selectedProfileId, setSelectedProfileId] = useState(resolveDefaultId);
  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selectedProfileId) ?? profiles[0],
    [profiles, selectedProfileId],
  );
  const [prefix, setPrefix] = useState(
    galleryFocus.prefix || selectedProfile?.defaultPrefix || "",
  );
  const [debouncedPrefix, setDebouncedPrefix] = useState(prefix);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce prefix changes for API calls
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedPrefix(prefix);
    }, 350);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [prefix]);

  const [objects, setObjects] = useState<GalleryObject[]>([]);
  const [unverifiedCount, setUnverifiedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextContinuationToken, setNextContinuationToken] = useState<string | null>(null);
  const [loadedScope, setLoadedScope] = useState<GalleryScope | null>(null);
  const loadGenerationRef = useRef(0);
  const pendingLoadRef = useRef<PendingGalleryLoad | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<GallerySort>("time-desc");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<GalleryFilters>(EMPTY_GALLERY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [view, setView] = useState<"grid" | "list">("grid");
  const prefixInputRef = useRef<HTMLInputElement>(null);
  const activeFilterCount = Object.values(filters).filter((value) => value !== "all").length;
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const namingTemplate = namingTemplateProp ?? "{yyyy}/{mm}/{slug}-{hash}.{ext}";
  const [uploadHasError, setUploadHasError] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [objectActions, setObjectActions] = useState(() => new Map<string, ObjectAction>());
  const currentAction = selectedProfile && objectActions.get(bucketIdentity(selectedProfile));
  const actionPending = currentAction?.status === "pending";
  const [localHighlights, setLocalHighlights] = useState<ScopedHighlights | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GalleryObject | null>(null);
  const [uploading, setUploading] = useState(false);
  const statusTimersRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentScopeRef = useRef<GalleryScope | null>(null);
  const scopeEditedByUserRef = useRef(false);
  const focusDefaultPrefix = profiles.find((profile) => profile.id === galleryFocus.profileId)?.defaultPrefix || "";
  const previousFocusRef = useRef({ ...galleryFocus, defaultPrefix: focusDefaultPrefix });
  const [focusRevision, setFocusRevision] = useState(0);

  useEffect(() => {
    currentScopeRef.current = selectedProfile
      ? { profile: selectedProfile, prefix }
      : null;
  }, [selectedProfile, prefix]);

  const resetGalleryScope = useCallback(() => {
    setLoadedScope(null);
    setObjects([]);
    setUnverifiedCount(0);
    setNextContinuationToken(null);
    setDeleteTarget(null);
    setPaginationError(null);
  }, []);

  // Settings may arrive after the gallery first renders with no profiles. Adopt
  // their defaults only while the user has not made an explicit scope choice.
  useEffect(() => {
    if (
      scopeEditedByUserRef.current ||
      galleryFocus.profileId ||
      galleryFocus.prefix ||
      profiles.length === 0
    ) {
      return;
    }

    const defaultProfile =
      profiles.find((profile) => profile.id === defaultProfileId) ?? profiles[0];
    if (!defaultProfile) return;

    const defaultPrefix = defaultProfile.defaultPrefix || "";
    if (selectedProfileId === defaultProfile.id && prefix === defaultPrefix) return;

    setSelectedProfileId(defaultProfile.id);
    setPrefix(defaultPrefix);
    setDebouncedPrefix(defaultPrefix);
    resetGalleryScope();
  }, [defaultProfileId, galleryFocus.prefix, galleryFocus.profileId, prefix, profiles, resetGalleryScope, selectedProfileId]);

  // Each upload supplies a new highlightedKeys array, even when its scope and
  // keys match the previous upload. Initial state already applies the first focus.
  useEffect(() => {
    const previous = previousFocusRef.current;
    const focusChanged = previous.profileId !== galleryFocus.profileId ||
      previous.prefix !== galleryFocus.prefix ||
      previous.highlightedKeys !== galleryFocus.highlightedKeys;
    const defaultChanged = !scopeEditedByUserRef.current && galleryFocus.profileId &&
      !galleryFocus.prefix && previous.defaultPrefix !== focusDefaultPrefix;
    previousFocusRef.current = { ...galleryFocus, defaultPrefix: focusDefaultPrefix };
    if (!focusChanged && !defaultChanged) return;

    if (galleryFocus.profileId) {
      setSelectedProfileId(galleryFocus.profileId);
      if (!galleryFocus.prefix) {
        setPrefix(focusDefaultPrefix);
        setDebouncedPrefix(focusDefaultPrefix);
      }
    }
    if (galleryFocus.prefix) {
      setPrefix(galleryFocus.prefix);
      setDebouncedPrefix(galleryFocus.prefix);
    }
    resetGalleryScope();
    setFocusRevision((current) => current + 1);
  }, [focusDefaultPrefix, galleryFocus.profileId, galleryFocus.prefix, galleryFocus.highlightedKeys, resetGalleryScope]);

  // Auto-dismiss transient status messages after a few seconds so stale
  // "URL copied" / "Saved to ..." banners don't linger across view changes.
  useEffect(() => {
    if (!copyMessage && !uploadStatus) return;
    if (statusTimersRef.current) clearTimeout(statusTimersRef.current);
    statusTimersRef.current = setTimeout(() => {
      setCopyMessage(null);
      if (!uploading) setUploadStatus(null);
    }, 4000);
    return () => {
      if (statusTimersRef.current) clearTimeout(statusTimersRef.current);
    };
  }, [copyMessage, uploadStatus, uploading]);

  const loadObjects = useCallback(async (append = false, continuationToken?: string) => {
    if (!selectedProfile) return;
    const generation = ++loadGenerationRef.current;
    const requestedPrefix = debouncedPrefix;
    const pending: PendingGalleryLoad = {
      profile: selectedProfile,
      appendedUploads: append ? new Set() : null,
      deletedUploads: [],
    };
    pendingLoadRef.current = pending;
    setLoading(!append);
    setLoadingMore(append);
    if (!append) {
      setError(null);
      resetGalleryScope();
    } else {
      setPaginationError(null);
    }
    try {
      const request = {
        profile: selectedProfile,
        prefix: requestedPrefix,
        ...(sortOrder === "time-desc" ? {} : { sort: sortOrder }),
        ...(continuationToken ? { continuationToken } : {}),
      };
      const page: ListGalleryObjectsResponse = await galleryApi.listObjects(request);
      if (generation !== loadGenerationRef.current) return;
      setObjects((current) => {
        // The first page starts with an empty list. An appended page keeps
        // existing records, so give precedence only to uploads added while it was pending.
        const localUploads = current.filter((object) =>
          pending.appendedUploads ? pending.appendedUploads.has(object) : object.key.startsWith(requestedPrefix),
        );
        const listed = page.objects.filter((object) => !pending.deletedUploads.some((deleted) => isSameUpload(object, deleted)));
        const merged = [...(append ? current : []), ...listed, ...localUploads];
        return sortGalleryObjects([...new Map(merged.map((object) => [object.key, object])).values()], sortOrder);
      });
      setUnverifiedCount((current) => append ? current + (page.unverifiedCount ?? 0) : (page.unverifiedCount ?? 0));
      setNextContinuationToken(page.nextContinuationToken ?? null);
      if (!append) {
        setLoadedScope({ profile: selectedProfile, prefix: requestedPrefix });
      }
    } catch (err) {
      if (generation !== loadGenerationRef.current) return;
      const message = errorMessage(err, t("Failed to load objects."));
      if (append) {
        setPaginationError(message);
      } else {
        setError(message);
      }
    } finally {
      if (generation === loadGenerationRef.current) {
        pendingLoadRef.current = null;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [resetGalleryScope, selectedProfile, debouncedPrefix, sortOrder]);

  useEffect(() => {
    void loadObjects();
    return () => {
      // Invalidate the request associated with the previous profile/prefix
      // before the next effect starts or the component unmounts.
      loadGenerationRef.current += 1;
      pendingLoadRef.current = null;
    };
  }, [focusRevision, loadObjects]);

  const handleLoadMore = () => {
    if (!scopeReady || !nextContinuationToken || loading || loadingMore) return;
    void loadObjects(true, nextContinuationToken);
  };

  const scopeReady = isSameScope(loadedScope, selectedProfile, prefix);

  const handleUploadLocal = async () => {
    if (!selectedProfile || uploading) return;
    const uploadScope = { profile: selectedProfile, prefix };
    setUploadStatus(null);
    setUploadHasError(false);
    setUploading(true);
    let endActivity: (() => Promise<void>) | undefined;
    try {
      endActivity = await beginUpdateActivity("gallery");
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: t("Images"),
            extensions: extensionsFor("galleryUpload"),
          },
        ],
      });
      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      const currentPrefix = selectedProfile.defaultPrefix;
      const newKeys: string[] = [];
      const newObjects: GalleryObject[] = [];
      const failures: string[] = [];
      let recordWarning = false;

      for (const filePath of paths) {
        const fileName = fileNameFromPath(filePath);
        const dotIndex = fileName.lastIndexOf(".");
        const ext = dotIndex > 0 ? fileName.substring(dotIndex + 1).toLowerCase() : "jpg";

        try {
          const { objectKey } = await namingApi.generateObjectKey({
            sourcePath: filePath,
            outputFileName: fileName,
            prefix: currentPrefix,
            namingTemplate,
            ext,
          });

          const result = await uploadApi.uploadObject({
            profile: selectedProfile,
            sourcePath: filePath,
            objectKey,
            contentType: contentTypeForExtension(ext),
            outputFilename: fileName,
          });

          recordWarning ||= Boolean(result.uploadRecordWarning);
          newKeys.push(objectKey);
          newObjects.push(result);
        } catch (err) {
          const message = errorMessage(err, t("Upload failed"));
          failures.push(`${fileName}: ${message}`);
        }
      }

      if (newKeys.length > 0 && isSameScope(currentScopeRef.current, selectedProfile, prefix)) {
        const visibleNewObjects = newObjects.filter((object) => object.key.startsWith(uploadScope.prefix));
        for (const object of visibleNewObjects) {
          pendingLoadRef.current?.appendedUploads?.add(object);
        }
        setLocalHighlights({ ...uploadScope, keys: visibleNewObjects.map((object) => object.key) });
        const newKeySet = new Set(newKeys);
        setObjects((current) => sortGalleryObjects([
          ...visibleNewObjects,
          ...current.filter((object) => !newKeySet.has(object.key)),
        ], sortOrder));
      }
      setUploadHasError(failures.length > 0 || recordWarning);
      setUploadStatus(
        failures.length > 0
          ? t("Uploaded {{value0}} image(s); {{value1}} failed. {{value2}}", { value0: newKeys.length, value1: failures.length, value2: failures.join("; ") })
          : t("Uploaded {{value0}} image(s).", { value0: newKeys.length }),
      );
      if (recordWarning) setUploadStatus((current) => `${current ?? ""} ${t("Could not save the local upload record. The image was uploaded, but may not appear in the gallery.")}`);
    } catch (err) {
      setUploadHasError(true);
      setUploadStatus(errorMessage(err, t("Upload failed")));
    } finally {
      await endActivity?.();
      setUploading(false);
    }
  };

  const highlightedKeys = useMemo(() => {
    if (!selectedProfile) return new Set<string>();

    const focusProfileId =
      galleryFocus.profileId ?? defaultProfileId ?? profiles[0]?.id ?? "";
    const focusProfile = profiles.find((profile) => profile.id === focusProfileId);
    const focusPrefix = galleryFocus.prefix || focusProfile?.defaultPrefix || "";
    const externalKeys =
      selectedProfile.id === focusProfileId && prefix === focusPrefix
        ? galleryFocus.highlightedKeys
        : [];
    const localKeys = localHighlights && isSameScope(localHighlights, selectedProfile, prefix)
      ? localHighlights.keys
      : [];

    return new Set([...externalKeys, ...localKeys]);
  }, [
    defaultProfileId,
    galleryFocus.highlightedKeys,
    galleryFocus.prefix,
    galleryFocus.profileId,
    localHighlights,
    prefix,
    profiles,
    selectedProfile,
  ]);

  const filteredObjects = useMemo(() => {
    return filterGalleryObjects(objects, search, filters);
  }, [objects, search, filters]);
  const searchIsActive = Boolean(search.trim()) || activeFilterCount > 0;

  const handleCopyUrl = async (obj: GalleryObject) => {
    if (!obj.publicUrl) return;
    try {
      await writeClipboard(obj.publicUrl);
      setCopyMessage(t("URL copied"));
    } catch {
      setCopyMessage(t("Failed to copy URL"));
    }
  };

  const handleView = async (obj: GalleryObject) => {
    if (!obj.publicUrl) return;
    try {
      await openUrl(obj.publicUrl);
    } catch (err) {
      setCopyMessage(t("View failed: {{value0}}", { value0: errorMessage(err, t("Unknown error")) }));
    }
  };

  const setObjectAction = (profile: S3Profile, action: ObjectAction | null) => {
    const bucket = bucketIdentity(profile);
    setObjectActions((current) => {
      const next = new Map(current);
      if (action) next.set(bucket, action);
      else next.delete(bucket);
      return next;
    });
  };

  const handleDownload = async (obj: GalleryObject) => {
    if (!selectedProfile || !scopeReady || actionPending) return;
    setObjectAction(selectedProfile, { status: "pending", kind: "download", key: obj.key });
    let failure: ObjectAction | null = null;
    try {
      const dir = await open({ directory: true });
      const outputDir = Array.isArray(dir) ? dir[0] : dir;
      if (!outputDir) return;
      const resultPath = await galleryApi.downloadObject({
        profile: selectedProfile,
        key: obj.key,
        outputDir,
      });
      if (isSameBucket(selectedProfile, currentScopeRef.current?.profile)) {
        setCopyMessage(t("Saved to {{value0}}", { value0: resultPath }));
      }
    } catch (err) {
      failure = { status: "failed", message: errorMessage(err, t("Download failed")) };
    } finally {
      setObjectAction(selectedProfile, failure);
    }
  };

  const handleDeleteRequest = (obj: GalleryObject) => {
    setDeleteTarget(obj);
  };

  const handleDeleteConfirm = async () => {
    if (!selectedProfile || !deleteTarget || !scopeReady || actionPending) return;
    const { key, uploadId, etag } = deleteTarget;
    setObjectAction(selectedProfile, { status: "pending", kind: "delete", key });
    setDeleteTarget(null);
    let failure: ObjectAction | null = null;
    try {
      await galleryApi.deleteObject({ profile: selectedProfile, key, uploadId, etag });
      const pending = pendingLoadRef.current;
      if (pending && isSameBucket(selectedProfile, pending.profile)) {
        pending.deletedUploads.push(deleteTarget);
      }
      if (isSameBucket(selectedProfile, currentScopeRef.current?.profile)) {
        setObjects((current) => current.filter((object) => !isSameUpload(object, deleteTarget)));
      }
      setLocalHighlights((current) =>
        current && isSameScope(current, selectedProfile, prefix)
          ? { ...current, keys: current.keys.filter((highlighted) => highlighted !== key) }
          : current,
      );
    } catch (err) {
      failure = {
        status: "failed",
        message: t("Failed to delete {{value0}}: {{value1}}", { value0: key, value1: errorMessage(err, t("Delete failed")) }),
      };
    } finally {
      setObjectAction(selectedProfile, failure);
    }
  };

  if (profiles.length === 0) {
    return (
      <div className="page gallery-page">
        <header className="page-head">
          <div>
            <h2 className="page-title">{t("S3 Gallery")}</h2>
          </div>
        </header>
        <div className="gallery-empty">
          <strong>{t("No profile selected.")}</strong>
          <p>{t("Add an S3 profile before browsing images.")}</p>
          {onNavigate && (
            <Button type="button" onClick={() => onNavigate("settings")}>
              {t("Add a profile in Settings")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page gallery-page">
      <header className="page-head">
        <div>
          <h2 className="page-title">{t("S3 Gallery")}</h2>
        </div>
        <Button type="button" onClick={handleUploadLocal} disabled={uploading}>{uploading ? t("Uploading...") : t("Upload local images")}</Button>
      </header>
      <section className="gallery-scope" aria-label={t("Gallery scope")}>
        <div className="gallery-profile">
          <NativeSelect
            aria-label={t("Profile")}
            value={selectedProfile?.id ?? ""}
            onChange={(e) => {
              scopeEditedByUserRef.current = true;
              const newId = e.target.value;
              setSelectedProfileId(newId);
              const newProfile = profiles.find((p) => p.id === newId);
              const newPrefix = newProfile?.defaultPrefix ?? "";
              setPrefix(newPrefix);
              setDebouncedPrefix(newPrefix); // immediate for programmatic changes
              resetGalleryScope();
            }}
          >
            {profiles.map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {p.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="gallery-prefix">
          <Folder className="size-4" aria-hidden="true" />
          <Input
            ref={prefixInputRef}
            aria-label={t("Prefix")}
            placeholder="images/2026/06"
            value={prefix}
            onChange={(e) => {
              scopeEditedByUserRef.current = true;
              setPrefix(e.target.value);
            }}
          />
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("Edit prefix")} onClick={() => prefixInputRef.current?.focus()}><Pencil className="size-3.5" aria-hidden="true" /></Button>
        </div>
        <p className="gallery-scope-note">{t("Only uploads from this device")}</p>
      </section>
      <section className="gallery-toolbar" aria-label={t("Search")}>
        <label className="gallery-search">
          <Search className="size-4" aria-hidden="true" />
          <Input
            aria-label={t("Search current prefix")}
            placeholder={t("Search loaded images")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <Button type="button" variant="outline" aria-expanded={filtersOpen} aria-controls="gallery-filters" onClick={() => setFiltersOpen((open) => !open)}><SlidersHorizontal className="size-4" aria-hidden="true" />{t("Filters")}{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}</Button>
        <div className="gallery-sort">
          <NativeSelect aria-label={t("Sort by")} disabled={uploading} value={sortOrder} onChange={(event) => {
            setSortOrder(event.target.value as GallerySort);
            resetGalleryScope();
          }}>
            <NativeSelectOption value="time-desc">{t("Upload time: newest first")}</NativeSelectOption>
            <NativeSelectOption value="time-asc">{t("Upload time: oldest first")}</NativeSelectOption>
            <NativeSelectOption value="name-asc">{t("File name: A–Z")}</NativeSelectOption>
            <NativeSelectOption value="name-desc">{t("File name: Z–A")}</NativeSelectOption>
          </NativeSelect>
        </div>
        <Button type="button" variant="outline" size="icon" aria-label={t(view === "grid" ? "List view" : "Grid view")} onClick={() => setView((current) => current === "grid" ? "list" : "grid")}>
          {view === "grid" ? <List className="size-4" aria-hidden="true" /> : <LayoutGrid className="size-4" aria-hidden="true" />}
        </Button>
      </section>
      <section id="gallery-filters" className="gallery-filters" aria-label={t("Filters")} hidden={!filtersOpen}>
        <label className="field"><span>{t("Format")}</span><NativeSelect aria-label={t("Format")} value={filters.format} onChange={(event) => setFilters((current) => ({ ...current, format: event.target.value }))}>
          <NativeSelectOption value="all">{t("Any format")}</NativeSelectOption>
          {["jpg", "png", "webp", "avif", "jxl", "heif"].map((format) => <NativeSelectOption key={format} value={format}>{format === "jxl" ? "JPEG XL" : format.toUpperCase()}</NativeSelectOption>)}
        </NativeSelect></label>
        <label className="field"><span>{t("Upload date")}</span><NativeSelect aria-label={t("Upload date")} value={filters.time} onChange={(event) => setFilters((current) => ({ ...current, time: event.target.value as GalleryFilters["time"] }))}>
          <NativeSelectOption value="all">{t("Any time")}</NativeSelectOption><NativeSelectOption value="today">{t("Today")}</NativeSelectOption><NativeSelectOption value="week">{t("Last 7 days")}</NativeSelectOption>
        </NativeSelect></label>
        <label className="field"><span>{t("File size")}</span><NativeSelect aria-label={t("File size")} value={filters.size} onChange={(event) => setFilters((current) => ({ ...current, size: event.target.value as GalleryFilters["size"] }))}>
          <NativeSelectOption value="all">{t("Any size")}</NativeSelectOption><NativeSelectOption value="small">{t("Under 500 KB")}</NativeSelectOption><NativeSelectOption value="large">{t("500 KB and above")}</NativeSelectOption>
        </NativeSelect></label>
        <Button type="button" variant="ghost" onClick={() => setFilters(EMPTY_GALLERY_FILTERS)}>{t("Reset filters")}</Button>
      </section>
      {activeFilterCount > 0 && <div className="gallery-filter-chips">
        {(Object.keys(filters) as Array<keyof GalleryFilters>).filter((key) => filters[key] !== "all").map((key) => <Button key={key} type="button" variant="secondary" size="xs" onClick={() => setFilters((current) => ({ ...current, [key]: "all" }))}>
          {key === "format" ? filters.format.toUpperCase() : key === "time" ? t(filters.time === "today" ? "Today" : "Last 7 days") : t(filters.size === "small" ? "Under 500 KB" : "500 KB and above")}<X className="size-3" aria-hidden="true" />
        </Button>)}
      </div>}
      {scopeReady && !loading && <p className="gallery-status" role="status">{t("{{shown}} of {{total}} images", { shown: filteredObjects.length, total: objects.length })}</p>}
      {selectedProfile && !selectedProfile.publicBaseUrl && (
        <Alert>
          <AlertDescription className="flex items-center justify-between gap-3 max-sm:items-start max-sm:flex-col">
            <span>{t("Public URLs are unavailable for this profile. Add a Public Base URL in Settings to view or copy object URLs.")}</span>
            {onNavigate && (
              <Button type="button" variant="outline" size="sm" onClick={() => onNavigate("settings")}>
                {t("Open Settings")}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {scopeReady && !loading && unverifiedCount > 0 && (
        <Alert className="border-amber-500/30 bg-amber-50 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">
          <AlertDescription className="flex items-center justify-between gap-3 max-sm:items-start max-sm:flex-col">
            <span>{t("Unverified objects hidden: {{count}}.", { count: unverifiedCount })}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadObjects()} disabled={loading || loadingMore}>
              {t("Refresh to retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {(copyMessage || uploadStatus) && (
        <div className="gallery-actions">
          {copyMessage && <p className="gallery-status" role="status">{copyMessage}</p>}
          {uploadStatus && (uploadHasError ? (
            <Alert variant="destructive">
              <AlertDescription>{uploadStatus}</AlertDescription>
            </Alert>
          ) : (
            <p className="gallery-status" role="status">{uploadStatus}</p>
          ))}
        </div>
      )}
      {(!scopeReady || loading) && !error && (
        <section className="contact-sheet" role="status" aria-label={t("Loading")} aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div className="proof" key={i}>
              <GalleryCardSkeleton />
            </div>
          ))}
        </section>
      )}
      {actionPending && (
        <div className="gallery-actions">
          <p className="gallery-status" role="status">{t(currentAction.kind === "delete" ? "Deleting" : "Downloading")} {currentAction.key}...</p>
        </div>
      )}
      {currentAction?.status === "failed" && (
        <Alert variant="destructive">
          <AlertDescription>{currentAction.message}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {scopeReady && !loading && !error && filteredObjects.length === 0 && (
        <div className="gallery-empty">
          <strong>{searchIsActive ? activeFilterCount > 0 ? t("No loaded images match these filters.") : t("No loaded objects match this search.") : t("No objects found.")}</strong>
          <p>
            {searchIsActive
              ? nextContinuationToken
                ? t("Search only covers loaded objects. Load more to continue searching.")
                : t("Search only covers loaded objects in this prefix.")
              : t("Upload images or adjust the current prefix.")}
          </p>
          {activeFilterCount > 0 && <Button type="button" variant="outline" onClick={() => { setFilters(EMPTY_GALLERY_FILTERS); setSearch(""); }}>{t("Clear filters")}</Button>}
          {!searchIsActive && (
            <Button type="button" onClick={handleUploadLocal}>
              {t("Upload local images")}
            </Button>
          )}
        </div>
      )}
      {scopeReady && !loading && !error && filteredObjects.length > 0 && (
        <ul className={cn("contact-sheet", view === "list" && "gallery-list")}>
          {filteredObjects.map((obj, index) => {
            const publicUrlReasonId = `public-url-unavailable-${index}`;
            return (
            <LazyRender as="li" key={obj.key} label={obj.key} position={index + 1} total={filteredObjects.length}
              className={cn("proof", highlightedKeys.has(obj.key) && "new")}
              placeholder={<GalleryCardSkeleton privateObject={!obj.publicUrl} />}
            >{() => <>
              <div className="proof-image">
                {obj.isImage && selectedProfile ? (
                  <GalleryThumbnail profile={selectedProfile} object={obj} onView={() => void handleView(obj)} />
                ) : <span>{t("File")}</span>}
                {highlightedKeys.has(obj.key) && <span className="proof-flag">{t("New")}</span>}
              </div>
              {obj.fileName && obj.fileName !== obj.key && <p className="proof-name" title={obj.fileName}>{obj.fileName}</p>}
              <p className="proof-key" title={obj.key}>{obj.key}</p>
              <div className="proof-actions">
                <Button variant="link" size="xs" className="proof-action" type="button" onClick={() => handleCopyUrl(obj)} disabled={!obj.publicUrl} aria-describedby={!obj.publicUrl ? publicUrlReasonId : undefined}>
                  {t("Copy URL")}
                </Button>
                <Button variant="link" size="xs" className="proof-action" type="button" onClick={() => handleView(obj)} disabled={!obj.publicUrl} aria-describedby={!obj.publicUrl ? publicUrlReasonId : undefined}>
                  {t("View")}
                </Button>
                <Button variant="link" size="xs" className="proof-action" type="button" onClick={() => handleDownload(obj)} disabled={actionPending}>
                  {t("Download")}
                </Button>
                <Button variant="link" size="xs" className="proof-action danger" type="button" onClick={() => handleDeleteRequest(obj)} disabled={actionPending}>
                  {t("Delete")}
                </Button>
              </div>
              {!obj.publicUrl && (
                <p id={publicUrlReasonId} className="proof-reason">
                  {t("Public URL unavailable. Configure a Public Base URL in Settings.")}
                </p>
              )}
            </>}</LazyRender>
            );
          })}
        </ul>
      )}
      {loadingMore && <section className="contact-sheet" role="status" aria-label={t("Loading more...")} aria-busy="true">
        {Array.from({ length: 3 }, (_, index) => <div className="proof" key={index}><GalleryCardSkeleton /></div>)}
      </section>}
      {scopeReady && nextContinuationToken && !error && (
        <div className="gallery-more">
          {paginationError && (
            <Alert variant="destructive">
              <AlertDescription>{t("Failed to load more:")} {paginationError}</AlertDescription>
            </Alert>
          )}
          <Button type="button" variant="outline" onClick={handleLoadMore} disabled={loadingMore}>
            {loadingMore ? t("Loading more...") : paginationError ? t("Retry load more") : t("Load more")}
          </Button>
        </div>
      )}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Delete {{value0}}?", { value0: deleteTarget?.key ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("This will permanently remove the object from S3. This action cannot be undone.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDeleteConfirm}>{t("Delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
