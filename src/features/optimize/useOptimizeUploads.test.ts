import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { OptimizeItem, S3Profile } from "../../types";
import { useOptimizeUploads } from "./useOptimizeUploads";

const { uploadObject } = vi.hoisted(() => ({ uploadObject: vi.fn() }));
vi.mock("../../api/tauri", () => ({
  uploadApi: { uploadObject },
  namingApi: { generateObjectKey: vi.fn(async () => ({ objectKey: "images/photo.webp" })) },
}));

it("finishes an in-flight batch at its captured destination then adopts the new default", async () => {
  const first: S3Profile = { id: "a", name: "A", endpoint: "https://example.com", region: "auto",
    bucket: "a", accessKeyId: "fake", pathStyle: true, defaultPrefix: "images" };
  const second = { ...first, id: "b", name: "B", bucket: "b" };
  const items: OptimizeItem[] = [{ id: "image", sourcePath: "/photo.jpg", fileName: "photo.jpg",
    sourceFormat: "jpg", originalBytes: 100, outputBytes: 50, outputPath: "/cache/photo.webp",
    outputFileName: "photo.webp", status: "compressed", settings: { quality: 85, targetFormat: "webp", removeGps: true } }];
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
