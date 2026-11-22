import { beforeEach, expect, it, vi } from "vitest";
import { imageApi } from "@/api/backend";
import { OptimizePreviews } from "./optimizePreviews";

vi.mock("@/api/backend", () => ({
  imageApi: { readThumbnail: vi.fn(), cancelImageTask: vi.fn(async () => {}) },
}));

const readThumbnail = vi.mocked(imageApi.readThumbnail);

beforeEach(() => { vi.clearAllMocks(); });

it("shares concurrent requests and cancels only after the last reader leaves", async () => {
  let finish!: (value: { dataUrl: string }) => void;
  readThumbnail.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const previews = new OptimizePreviews();
  const first = previews.read("item", "image.png", 96);
  const second = previews.read("item", "image.png", 96);
  expect(first.result).toBe(second.result);
  first.release();
  expect(imageApi.cancelImageTask).not.toHaveBeenCalled();
  second.release();
  expect(imageApi.cancelImageTask).toHaveBeenCalledWith({ taskId: readThumbnail.mock.calls[0][0].taskId });
  finish({ dataUrl: "late" });
  await first.result;
  readThumbnail.mockResolvedValueOnce({ dataUrl: "current" });
  await expect(previews.read("item", "image.png", 96).result).resolves.toBe("current");
  expect(readThumbnail).toHaveBeenCalledTimes(2);
});

it("evicts cached previews by byte size and recent use", async () => {
  readThumbnail.mockResolvedValue({ dataUrl: "a".repeat(2 * 1024 * 1024) });
  const previews = new OptimizePreviews();
  for (const key of ["a", "b", "a", "c", "a", "b"]) {
    await previews.read(key, key, 1024).result;
  }
  expect(readThumbnail.mock.calls.map(([request]) => request.path)).toEqual(["a", "b", "c", "b"]);
});
