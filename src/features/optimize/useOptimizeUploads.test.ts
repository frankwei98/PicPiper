import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { OptimizeItem, S3Profile } from "../../types";
import { useOptimizeUploads } from "./useOptimizeUploads";

const { generateObjectKey, uploadObject } = vi.hoisted(() => ({ generateObjectKey: vi.fn(), uploadObject: vi.fn() }));
vi.mock("../../api/backend", () => ({
  uploadApi: { uploadObject },
  namingApi: { generateObjectKey },
}));

beforeEach(() => {
  uploadObject.mockReset();
  generateObjectKey.mockReset();
  generateObjectKey.mockResolvedValue({ objectKey: "images/photo.webp" });
});

it("finishes an in-flight batch at its captured destination then adopts the new default", async () => {
  const first: S3Profile = { id: "a", name: "A", endpoint: "https://example.com", region: "auto",
    bucket: "a", accessKeyId: "fake", pathStyle: true, defaultPrefix: "images" };
  const second = { ...first, id: "b", name: "B", bucket: "b" };
  const items: OptimizeItem[] = [{ id: "image", sourcePath: "/photo.jpg", fileName: "photo.jpg",
    sourceFormat: "jpg", originalBytes: 100, outputBytes: 50, outputPath: "/cache/photo.webp",
    outputFileName: "photo.webp", status: "compressed", settings: { quality: 85, targetFormat: "jpg", removeGps: true } }];
  let complete!: (value: unknown) => void;
  uploadObject.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const onUploadedToS3 = vi.fn();
  const { result, rerender } = renderHook(({ activeProfile }) => useOptimizeUploads({
    activeProfile, items, currentQuality: 85, namingTemplate: "{slug}.{ext}", onUploadedToS3,
  }), { initialProps: { activeProfile: first } });
  let upload!: Promise<void>;
  act(() => { upload = result.current.uploadToS3(); });
  await waitFor(() => expect(uploadObject).toHaveBeenCalled());
  rerender({ activeProfile: second });
  expect(result.current.uploadProfile?.id).toBe("a");
  await act(async () => { complete({ key: "images/photo.webp" }); await upload; });
  expect(onUploadedToS3).toHaveBeenCalledWith(expect.objectContaining({ profileId: "a" }));
  expect(result.current.uploadProfile?.id).toBe("b");
  expect(result.current.newUploadItemCount).toBe(1);
  uploadObject.mockResolvedValueOnce({ key: "images/photo.webp" });
  await act(async () => { await result.current.uploadToS3(); });
  expect(uploadObject).toHaveBeenLastCalledWith(expect.objectContaining({ profile: second }));
});

it("keeps a successful upload out of the retry queue when its local history could not be saved", async () => {
  uploadObject.mockResolvedValueOnce({ key: "images/photo.jpg", uploadRecordWarning: true });
  const profile: S3Profile = { id: "a", name: "A", endpoint: "https://s3.example.com", bucket: "a", region: "auto", accessKeyId: "fake", pathStyle: true, defaultPrefix: "images" };
  const items: OptimizeItem[] = [{ id: "image", sourcePath: "/photo.jpg", fileName: "photo.jpg", sourceFormat: "jpg", originalBytes: 100, outputBytes: 50, outputPath: "/cache/photo.jpg", outputFileName: "photo.jpg", status: "compressed", settings: { quality: 85, targetFormat: "jpg", removeGps: true } }];
  const onUploadedToS3 = vi.fn();
  const { result } = renderHook(() => useOptimizeUploads({ activeProfile: profile, items, currentQuality: 85, namingTemplate: "{slug}.{ext}", onUploadedToS3 }));
  await act(async () => { await result.current.uploadToS3(); });
  expect(onUploadedToS3).toHaveBeenCalled();
  expect(result.current.failedUploadCount).toBe(0);
  expect(result.current.newUploadItemCount).toBe(0);
  expect(result.current.uploadError).toContain("The image was uploaded");
  expect(uploadObject).toHaveBeenCalledTimes(1);
});

it.each(["", "custom/images"])("preserves profile prefix %j for uploads, retries and gallery focus", async (prefix) => {
  const profile: S3Profile = { id: "a", name: "A", endpoint: "https://s3.example.test", bucket: "a", region: "auto", accessKeyId: "fake", pathStyle: true, defaultPrefix: prefix };
  const items: OptimizeItem[] = [{ id: "image", sourcePath: "/photo.jpg", fileName: "photo.jpg", sourceFormat: "jpg", originalBytes: 100, outputBytes: 50, outputPath: "/cache/photo.jpg", outputFileName: "photo.jpg", status: "compressed", settings: { quality: 85, targetFormat: "jpg", removeGps: true } }];
  const objectKey = prefix ? `${prefix}/photo.jpg` : "photo.jpg";
  generateObjectKey.mockResolvedValue({ objectKey });
  uploadObject.mockRejectedValueOnce(new Error("Upload unavailable"));
  uploadObject.mockResolvedValueOnce({ key: objectKey });
  const onUploadedToS3 = vi.fn();
  const { result } = renderHook(() => useOptimizeUploads({ activeProfile: profile, items, currentQuality: 85, namingTemplate: "{slug}.{ext}", onUploadedToS3 }));

  await act(async () => { await result.current.uploadToS3(); });
  expect(result.current.failedUploadCount).toBe(1);
  expect(generateObjectKey).toHaveBeenNthCalledWith(1, expect.objectContaining({ prefix }));
  expect(onUploadedToS3).not.toHaveBeenCalled();

  await act(async () => { await result.current.retryUploads(); });
  expect(generateObjectKey).toHaveBeenNthCalledWith(2, expect.objectContaining({ prefix }));
  expect(result.current.failedUploadCount).toBe(0);
  expect(onUploadedToS3).toHaveBeenCalledWith({ profileId: profile.id, prefix, highlightedKeys: [objectKey] });
});
