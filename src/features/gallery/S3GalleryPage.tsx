import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { GalleryObject, S3Profile } from "../../types";
import type { GalleryFocus } from "../../state/appState";
import type { AppView } from "../../types";
import { galleryApi, namingApi, uploadApi, type ListGalleryObjectsResponse } from "../../api/tauri";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { fileNameFromPath } from "../../lib/path";
import { errorMessage } from "../../lib/error";

interface S3GalleryPageProps {
  galleryFocus: GalleryFocus;
  profiles: S3Profile[];
  defaultProfileId?: string;
  namingTemplate?: string;
  onNavigate?: (view: AppView) => void;
}

export function S3GalleryPage({ galleryFocus, profiles, defaultProfileId, namingTemplate: namingTemplateProp, onNavigate }: S3GalleryPageProps) {
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
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextContinuationToken, setNextContinuationToken] = useState<string | null>(null);
  const [loadedScope, setLoadedScope] = useState<{ profileId: string; prefix: string } | null>(null);
  const loadGenerationRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const namingTemplate = namingTemplateProp ?? "{yyyy}/{mm}/{slug}-{hash}.{ext}";
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [highlightedKeysState, setHighlightedKeysState] = useState<string[]>(galleryFocus.highlightedKeys);
  const [deleteTarget, setDeleteTarget] = useState<GalleryObject | null>(null);
  const [imgErrors, setImgErrors] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const statusTimersRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentScopeRef = useRef<{ profileId: string; prefix: string } | null>(null);
  const scopeEditedByUserRef = useRef(false);

  useEffect(() => {
    currentScopeRef.current = selectedProfile
      ? { profileId: selectedProfile.id, prefix }
      : null;
  }, [selectedProfile?.id, prefix]);

  const isCurrentScope = (scope: { profileId: string; prefix: string }) =>
    currentScopeRef.current?.profileId === scope.profileId &&
    currentScopeRef.current.prefix === scope.prefix;

  const resetGalleryScope = useCallback(() => {
    setLoadedScope(null);
    setObjects([]);
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
    setSelectedProfileId(defaultProfile.id);
    setPrefix(defaultPrefix);
    setDebouncedPrefix(defaultPrefix);
    resetGalleryScope();
  }, [defaultProfileId, galleryFocus.prefix, galleryFocus.profileId, profiles, resetGalleryScope]);

  // Sync profile and prefix when galleryFocus changes externally
  useEffect(() => {
    resetGalleryScope();
    if (galleryFocus.profileId) {
      setSelectedProfileId(galleryFocus.profileId);
      const p = profiles.find((pr) => pr.id === galleryFocus.profileId);
      if (p && !galleryFocus.prefix) {
        const newPrefix = p.defaultPrefix || "";
        setPrefix(newPrefix);
        setDebouncedPrefix(newPrefix); // immediate for programmatic changes
      }
    }
    if (galleryFocus.prefix) {
      setPrefix(galleryFocus.prefix);
      setDebouncedPrefix(galleryFocus.prefix); // immediate for programmatic changes
    }
  }, [galleryFocus.profileId, galleryFocus.prefix, profiles, resetGalleryScope]);

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
        ...(continuationToken ? { continuationToken } : {}),
      };
      const page: ListGalleryObjectsResponse = await galleryApi.listObjects(request);
      if (generation !== loadGenerationRef.current) return;
      setObjects((current) => (append ? [...current, ...page.objects] : page.objects));
      setNextContinuationToken(page.nextContinuationToken ?? null);
      if (!append) {
        setLoadedScope({ profileId: selectedProfile.id, prefix: requestedPrefix });
      }
      if (!append) setImgErrors(new Set());
    } catch (err) {
      if (generation !== loadGenerationRef.current) return;
      const message = errorMessage(err, "Failed to load objects.");
      if (append) {
        setPaginationError(message);
      } else {
        setError(message);
      }
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [resetGalleryScope, selectedProfile, debouncedPrefix]);

  useEffect(() => {
    void loadObjects();
    return () => {
      // Invalidate the request associated with the previous profile/prefix
      // before the next effect starts or the component unmounts.
      loadGenerationRef.current += 1;
    };
  }, [loadObjects]);

  const handleLoadMore = () => {
    if (!scopeReady || !nextContinuationToken || loading || loadingMore) return;
    void loadObjects(true, nextContinuationToken);
  };

  const scopeReady = Boolean(
    selectedProfile &&
      loadedScope?.profileId === selectedProfile.id &&
      loadedScope.prefix === prefix,
  );

  const handleUploadLocal = async () => {
    if (!selectedProfile || uploading) return;
    const uploadScope = { profileId: selectedProfile.id, prefix };
    setUploadStatus(null);
    setUploading(true);
    try {
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "Images",
            extensions: ["jpg", "jpeg", "png", "webp", "avif", "heif", "heic"],
          },
        ],
      });
      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      const currentPrefix = prefix || selectedProfile.defaultPrefix || "images";
      const newKeys: string[] = [];
      const newObjects: GalleryObject[] = [];
      const failures: string[] = [];

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

          const contentTypeMap: Record<string, string> = {
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            png: "image/png",
            webp: "image/webp",
            avif: "image/avif",
            heif: "image/heif",
            heic: "image/heic",
          };

          const result = await uploadApi.uploadObject({
            profile: selectedProfile,
            sourcePath: filePath,
            objectKey,
            contentType: contentTypeMap[ext] ?? "application/octet-stream",
          });

          newKeys.push(objectKey);
          newObjects.push(result);
        } catch (err) {
          const message = errorMessage(err, "Upload failed");
          failures.push(`${fileName}: ${message}`);
        }
      }

      if (newKeys.length > 0 && isCurrentScope(uploadScope)) {
        setHighlightedKeysState(newKeys);
        const newKeySet = new Set(newKeys);
        setObjects((current) => [
          ...newObjects,
          ...current.filter((object) => !newKeySet.has(object.key)),
        ]);
      }
      setUploadStatus(
        failures.length > 0
          ? `Uploaded ${newKeys.length} image(s); ${failures.length} failed. ${failures.join("; ")}`
          : `Uploaded ${newKeys.length} image(s).`,
      );
    } catch (err) {
      setUploadStatus(errorMessage(err, "Upload failed"));
    } finally {
      setUploading(false);
    }
  };

  const highlightedKeys = useMemo(
    () => new Set([...galleryFocus.highlightedKeys, ...highlightedKeysState]),
    [galleryFocus.highlightedKeys, highlightedKeysState],
  );

  const filteredObjects = useMemo(() => {
    if (!search.trim()) return objects;
    const q = search.toLowerCase();
    return objects.filter((obj) => obj.key.toLowerCase().includes(q));
  }, [objects, search]);
  const searchIsActive = Boolean(search.trim());

  const handleCopyUrl = async (obj: GalleryObject) => {
    if (!obj.publicUrl) {
      setCopyMessage("Public Base URL missing");
      return;
    }
    try {
      await navigator.clipboard.writeText(obj.publicUrl);
      setCopyMessage("URL copied");
    } catch {
      setCopyMessage("Failed to copy URL");
    }
  };

  const handleView = async (obj: GalleryObject) => {
    if (!obj.publicUrl) return;
    try {
      await openUrl(obj.publicUrl);
    } catch (err) {
      setCopyMessage(`View failed: ${errorMessage(err, "Unknown error")}`);
    }
  };

  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownload = async (obj: GalleryObject) => {
    if (!selectedProfile || !scopeReady) return;
    setDownloadingKey(obj.key);
    setDownloadError(null);
    try {
      const dir = await open({ directory: true });
      if (!dir) {
        setDownloadingKey(null);
        return;
      }
      const resultPath = await galleryApi.downloadObject({
        profile: selectedProfile,
        key: obj.key,
        outputDir: dir,
      });
      setCopyMessage(`Saved to ${resultPath}`);
    } catch (err) {
      setDownloadError(errorMessage(err, "Download failed"));
    } finally {
      setDownloadingKey(null);
    }
  };

  const handleDeleteRequest = (obj: GalleryObject) => {
    setDeleteTarget(obj);
  };

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDeleteConfirm = async () => {
    if (!selectedProfile || !deleteTarget || !scopeReady) return;
    const deleteScope = { profileId: selectedProfile.id, prefix };
    const targetKey = deleteTarget.key;
    setDeletingKey(targetKey);
    setDeleteTarget(null);
    setDeleteError(null);
    try {
      await galleryApi.deleteObject({ profile: selectedProfile, key: targetKey });
      if (isCurrentScope(deleteScope)) {
        setObjects((current) => current.filter((object) => object.key !== targetKey));
        setHighlightedKeysState((current) => current.filter((key) => key !== targetKey));
      }
    } catch (err) {
      setDeleteError(`Failed to delete ${targetKey}: ${errorMessage(err, "Delete failed")}`);
    } finally {
      setDeletingKey(null);
    }
  };

  if (profiles.length === 0) {
    return (
      <div className="grid max-w-6xl gap-6">
        <header className="flex justify-between items-start gap-6">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-balance">S3 Gallery</h2>
            <p className="text-muted-foreground mt-2 text-sm text-pretty">Browse a profile and prefix, then copy URLs or manage images.</p>
          </div>
        </header>
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No profile selected.</EmptyTitle>
            <EmptyDescription>Add an S3 profile before browsing images.</EmptyDescription>
          </EmptyHeader>
          {onNavigate && (
            <EmptyContent>
              <Button type="button" onClick={() => onNavigate("settings")}>
                Add a profile in Settings
              </Button>
            </EmptyContent>
          )}
        </Empty>
      </div>
    );
  }

  return (
    <div className="grid max-w-6xl gap-6">
      <header className="flex justify-between items-start gap-6 max-sm:flex-col">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight text-balance">S3 Gallery</h2>
          <p className="text-muted-foreground mt-2 text-sm text-pretty">Browse a profile and prefix, then copy URLs or manage images.</p>
        </div>
        <Button type="button" onClick={handleUploadLocal} disabled={uploading}>{uploading ? "Uploading..." : "Upload local images"}</Button>
      </header>
      <section className="grid gap-3 grid-cols-3 max-md:grid-cols-1">
        <NativeSelect
          aria-label="Profile"
          className="w-full"
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
        <Input
          aria-label="Prefix"
          placeholder="images/2026/06"
          value={prefix}
          onChange={(e) => {
            scopeEditedByUserRef.current = true;
            setPrefix(e.target.value);
          }}
        />
        <Input
          aria-label="Search current prefix"
          placeholder="Search current prefix"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </section>
      {copyMessage && (
        <p className="text-sm text-muted-foreground" role="status">{copyMessage}</p>
      )}
      {uploadStatus && (
        uploadStatus.includes("failed") ? (
          <Alert variant="destructive">
            <AlertDescription>{uploadStatus}</AlertDescription>
          </Alert>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">{uploadStatus}</p>
        )
      )}
      {(!scopeReady || loading) && !error && (
        <section className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]" aria-label="Loading">
          {Array.from({ length: 6 }, (_, i) => (
            <Card key={i}>
              <CardContent className="grid gap-3">
                <Skeleton className="aspect-[4/3] w-full" aria-hidden="true" />
                <Skeleton className="h-4 w-3/4" aria-hidden="true" />
              </CardContent>
            </Card>
          ))}
        </section>
      )}
      {deletingKey && <p className="text-sm text-muted-foreground" role="status">Deleting {deletingKey}...</p>}
      {downloadingKey && <p className="text-sm text-muted-foreground" role="status">Downloading {downloadingKey}...</p>}
      {deleteError && (
        <Alert variant="destructive">
          <AlertDescription>{deleteError}</AlertDescription>
        </Alert>
      )}
      {downloadError && (
        <Alert variant="destructive">
          <AlertDescription>{downloadError}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {scopeReady && !loading && !error && filteredObjects.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>{searchIsActive ? "No loaded objects match this search." : "No objects found."}</EmptyTitle>
            <EmptyDescription>
              {searchIsActive
                ? nextContinuationToken
                  ? "Search only covers loaded objects. Load more to continue searching."
                  : "Search only covers loaded objects in this prefix."
                : "Upload images or adjust the current prefix."}
            </EmptyDescription>
          </EmptyHeader>
          {!searchIsActive && (
            <EmptyContent>
              <Button type="button" onClick={handleUploadLocal}>
                Upload local images
              </Button>
            </EmptyContent>
          )}
        </Empty>
      )}
      {scopeReady && !loading && !error && filteredObjects.length > 0 && (
        <section className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
          {filteredObjects.map((obj) => (
            <Card
              key={obj.key}
              className={cn(
                "transition-[transform,box-shadow] hover:-translate-y-px",
                highlightedKeys.has(obj.key) && "ring-primary ring-2",
              )}
            >
              <CardContent className="grid gap-3">
                <div className="aspect-[4/3] bg-muted rounded-lg text-muted-foreground flex justify-center items-center overflow-hidden text-xs">
                  {obj.isImage && obj.publicUrl && !imgErrors.has(obj.key) ? (
                    <img
                      className="w-full h-full object-cover"
                      src={obj.publicUrl}
                      alt={obj.key}
                      loading="lazy"
                      onError={() => setImgErrors((prev) => new Set(prev).add(obj.key))}
                    />
                  ) : (
                    <span className="opacity-70">
                      {!obj.isImage ? "File" : "Image"}
                    </span>
                  )}
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <p className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground tabular-nums">{obj.key}</p>
                  {highlightedKeys.has(obj.key) && <Badge variant="secondary">New</Badge>}
                </div>
                <div className="grid gap-1.5 grid-cols-2">
                  <Button variant="outline" size="sm" type="button" onClick={() => handleCopyUrl(obj)}>
                    Copy URL
                  </Button>
                  <Button variant="outline" size="sm" type="button" onClick={() => handleView(obj)}>
                    View
                  </Button>
                  <Button variant="outline" size="sm" type="button" onClick={() => handleDownload(obj)} disabled={downloadingKey !== null || deletingKey !== null}>
                    Download
                  </Button>
                  <Button variant="destructive" size="sm" type="button" onClick={() => handleDeleteRequest(obj)} disabled={deletingKey !== null || downloadingKey !== null}>
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </section>
      )}
      {scopeReady && nextContinuationToken && !error && (
        <div className="flex justify-center">
          {paginationError && (
            <Alert variant="destructive">
              <AlertDescription>Failed to load more: {paginationError}</AlertDescription>
            </Alert>
          )}
          <Button type="button" variant="outline" onClick={handleLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading more..." : paginationError ? "Retry load more" : "Load more"}
          </Button>
        </div>
      )}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Delete ${deleteTarget?.key ?? ""}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the object from S3. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDeleteConfirm}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
