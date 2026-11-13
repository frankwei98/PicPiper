import { t } from "@/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { namingApi, uploadApi } from "../../api/backend";
import { errorCode, errorMessage } from "../../lib/error";
import { contentTypeForExtension } from "../../lib/imageFormats";
import type { GalleryFocus } from "../../state/appState";
import type { OptimizeItem, S3Profile } from "../../types";
import { isCurrentCompressionOutput } from "./optimizeQueue";

interface UploadFailure {
  code?: string;
  message: string;
}

interface UseOptimizeUploadsOptions {
  activeProfile?: S3Profile;
  currentQuality: number;
  items: OptimizeItem[];
  namingTemplate: string;
  onUploadedToS3?: (focus: GalleryFocus) => void;
}

interface UploadBatchResult {
  recordWarning: boolean;
  newlyUploaded: string[];
  newlyUploadedItemIds: string[];
  failed: Map<string, UploadFailure>;
}

export function useOptimizeUploads({
  activeProfile,
  currentQuality,
  items,
  namingTemplate,
  onUploadedToS3,
}: UseOptimizeUploadsOptions) {
  const targetKey = JSON.stringify([activeProfile?.id, activeProfile?.endpoint, activeProfile?.region,
    activeProfile?.bucket, activeProfile?.defaultPrefix, activeProfile?.pathStyle, namingTemplate]);
  const trackedTargetKey = useRef(targetKey);
  const [batchProfile, setBatchProfile] = useState<S3Profile | undefined>();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadingItemIds, setUploadingItemIds] = useState<Set<string>>(new Set());
  const [failedUploads, setFailedUploads] = useState<Map<string, UploadFailure>>(new Map());
  const [uploadedItemIds, setUploadedItemIds] = useState<Set<string>>(new Set());
  const failedUploadsRef = useRef<Map<string, UploadFailure>>(new Map());
  const uploadedKeysRef = useRef<string[]>([]);
  const collisionRetryAttempts = useRef(new Map<string, number>());
  const uploadInProgressRef = useRef(false);

  const canMutateQueue = useCallback(() => !uploadInProgressRef.current, []);

  const updateFailedUploads = useCallback(
    (update: (current: Map<string, UploadFailure>) => Map<string, UploadFailure>) => {
      const next = update(failedUploadsRef.current);
      failedUploadsRef.current = next;
      setFailedUploads(() => next);
      return next;
    },
    [],
  );

  const forgetItem = useCallback((itemId: string) => {
    if (!canMutateQueue()) return false;

    setUploadedItemIds((current) => {
      const next = new Set(current);
      next.delete(itemId);
      return next;
    });
    updateFailedUploads((current) => {
      const next = new Map(current);
      next.delete(itemId);
      return next;
    });
    collisionRetryAttempts.current.delete(itemId);
    return true;
  }, [canMutateQueue, updateFailedUploads]);

  const reset = useCallback(() => {
    if (!canMutateQueue()) return false;

    setUploadedItemIds(() => new Set());
    updateFailedUploads(() => new Map());
    uploadedKeysRef.current = [];
    collisionRetryAttempts.current.clear();
    return true;
  }, [canMutateQueue, updateFailedUploads]);

  // A completed/failed upload belongs to one destination. When settings change
  // during a batch, finish that captured batch before adopting the new target.
  useEffect(() => {
    if (trackedTargetKey.current === targetKey || uploadInProgressRef.current) return;
    trackedTargetKey.current = targetKey;
    reset();
    setUploadError(null);
  }, [targetKey, uploadingItemIds.size, reset]);

  const executeUploads = async (
    uploadItems: OptimizeItem[],
    profile: S3Profile,
    prefix: string,
    collisionRetryItemIds = new Set<string>(),
  ): Promise<UploadBatchResult> => {
    uploadInProgressRef.current = true;
    setBatchProfile(profile);
    const remainingItemIds = new Set(uploadItems.map((item) => item.id));
    setUploadingItemIds(remainingItemIds);
    const newlyUploaded: string[] = [];
    const newlyUploadedItemIds: string[] = [];
    const failed = new Map<string, UploadFailure>();
    let recordWarning = false;

    try {
      for (const item of uploadItems) {
        const outputFileName = item.outputFileName ?? "image.jpg";
        const extension = item.settings.targetFormat;
        try {
          const collisionSuffix = collisionRetryItemIds.has(item.id)
            ? `retry-${(collisionRetryAttempts.current.get(item.id) ?? 0) + 1}`
            : undefined;
          if (collisionSuffix) {
            collisionRetryAttempts.current.set(
              item.id,
              (collisionRetryAttempts.current.get(item.id) ?? 0) + 1,
            );
          }
          const { objectKey } = await namingApi.generateObjectKey({
            sourcePath: item.outputPath as string,
            outputFileName,
            prefix,
            namingTemplate,
            ext: extension,
            ...(collisionSuffix ? { collisionSuffix } : {}),
          });

          const result = await uploadApi.uploadObject({
            profile,
            sourcePath: item.outputPath as string,
            objectKey,
            contentType: contentTypeForExtension(extension),
            sourceFilename: item.fileName,
            outputFilename: outputFileName,
            originalBytes: item.originalBytes,
            targetFormat: extension,
          });

          recordWarning ||= Boolean(result.uploadRecordWarning);
          newlyUploaded.push(result.key);
          newlyUploadedItemIds.push(item.id);
          collisionRetryAttempts.current.delete(item.id);
        } catch (error) {
          failed.set(item.id, {
            code: errorCode(error),
            message: errorMessage(error, t("Upload failed")),
          });
        }

        remainingItemIds.delete(item.id);
        setUploadingItemIds(() => new Set(remainingItemIds));
      }
    } finally {
      setUploadingItemIds(() => new Set());
      uploadInProgressRef.current = false;
    }

    return { newlyUploaded, newlyUploadedItemIds, failed, recordWarning };
  };

  const uploadToS3 = async () => {
    if (!canMutateQueue()) return;
    if (!activeProfile) {
      setUploadError(t("Configure and select an S3 profile before uploading."));
      return;
    }
    setUploadError(null);
    const currentFailures = failedUploadsRef.current;
    if (currentFailures.size === 0) {
      collisionRetryAttempts.current.clear();
    }
    const prefix = activeProfile.defaultPrefix || "images";
    const compressedItems = items.filter(
      (item) =>
        isCurrentCompressionOutput(item, currentQuality) &&
        !uploadedItemIds.has(item.id) &&
        !currentFailures.has(item.id),
    );
    if (compressedItems.length === 0) {
      setUploadError(t("No compressed outputs to upload."));
      return;
    }

    const { newlyUploaded, newlyUploadedItemIds, failed, recordWarning } = await executeUploads(
      compressedItems,
      activeProfile,
      prefix,
    );
    const remainingFailures = updateFailedUploads((current) => {
      const next = new Map(current);
      for (const item of compressedItems) {
        next.delete(item.id);
      }
      for (const [itemId, failure] of failed) {
        next.set(itemId, failure);
      }
      return next;
    });
    setUploadedItemIds((current) => new Set([...current, ...newlyUploadedItemIds]));

    const allUploadedKeys = [...uploadedKeysRef.current, ...newlyUploaded];
    uploadedKeysRef.current = allUploadedKeys;

    if (remainingFailures.size === 0) {
      onUploadedToS3?.({
        profileId: activeProfile.id,
        prefix,
        highlightedKeys: allUploadedKeys,
      });
    } else if (failed.size === 0) {
      setUploadError(t("{{count}} failed upload(s) still need retrying.", { count: remainingFailures.size }));
    } else {
      setUploadError(
        t("{{count}} of {{total}} upload(s) failed. Fix and retry.", { count: failed.size, total: compressedItems.length }),
      );
    }
    if (recordWarning) setUploadError((current) => [current, t("Could not save the local upload record. The image was uploaded, but may not appear in the gallery.")].filter(Boolean).join(" "));
  };

  const retryUploads = async () => {
    if (!canMutateQueue()) return;
    if (!activeProfile) {
      setUploadError(t("Configure and select an S3 profile before uploading."));
      return;
    }
    setUploadError(null);
    const prefix = activeProfile.defaultPrefix || "images";
    const currentFailures = failedUploadsRef.current;
    const failedItems = items.filter(
      (item) =>
        isCurrentCompressionOutput(item, currentQuality) && currentFailures.has(item.id),
    );
    if (failedItems.length === 0) {
      setUploadError(t("No failed uploads to retry."));
      return;
    }

    const collisionRetryItemIds = new Set(
      failedItems
        .filter((item) => currentFailures.get(item.id)?.code === "objectAlreadyExists")
        .map((item) => item.id),
    );
    const { newlyUploaded, newlyUploadedItemIds, failed: stillFailed, recordWarning } = await executeUploads(
      failedItems,
      activeProfile,
      prefix,
      collisionRetryItemIds,
    );
    updateFailedUploads(() => stillFailed);
    setUploadedItemIds((current) => new Set([...current, ...newlyUploadedItemIds]));

    const allUploadedKeys = [...uploadedKeysRef.current, ...newlyUploaded];
    uploadedKeysRef.current = allUploadedKeys;

    if (stillFailed.size === 0) {
      onUploadedToS3?.({
        profileId: activeProfile.id,
        prefix,
        highlightedKeys: allUploadedKeys,
      });
    } else {
      setUploadError(
        t("{{count}} of {{total}} upload(s) failed. Fix and retry.", { count: stillFailed.size, total: failedItems.length }),
      );
    }
    if (recordWarning) setUploadError((current) => [current, t("Could not save the local upload record. The image was uploaded, but may not appear in the gallery.")].filter(Boolean).join(" "));
  };

  const newUploadItemCount = items.filter(
    (item) =>
      isCurrentCompressionOutput(item, currentQuality) &&
      !uploadedItemIds.has(item.id) &&
      !failedUploads.has(item.id),
  ).length;

  return {
    canMutateQueue,
    failedUploadCount: failedUploads.size,
    failureMessageFor: (itemId: string) => failedUploads.get(itemId)?.message,
    forgetItem,
    hasCollisionFailure: Array.from(failedUploads.values()).some(
      (failure) => failure.code === "objectAlreadyExists",
    ),
    isItemUploading: (itemId: string) => uploadingItemIds.has(itemId),
    isUploading: uploadingItemIds.size > 0,
    newUploadItemCount,
    reset,
    retryUploads,
    uploadError,
    uploadingItemCount: uploadingItemIds.size,
    uploadToS3,
    uploadProfile: uploadingItemIds.size > 0 ? batchProfile : activeProfile,
  };
}
