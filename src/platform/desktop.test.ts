import { beforeEach, expect, it, vi } from "vitest";
import { onFileDrop, onImagesOpened } from "./desktop";

const mocks = vi.hoisted(() => {
  const opened = new Set<(paths: string[]) => void>();
  const dropped = new Set<(event: { paths: string[] }) => void>();
  return { opened, dropped, take: vi.fn(async (): Promise<string[]> => []) };
});

vi.mock("mygo-runtime", () => ({
  isMyGo: () => true,
  onFileDrop: (listener: (event: { paths: string[] }) => void) => {
    mocks.dropped.add(listener);
    return () => { mocks.dropped.delete(listener); };
  },
}));
vi.mock("../mygo", () => ({
  Backend: { takeOpenedFiles: mocks.take },
  events: { imagesOpened: { on: (listener: (paths: string[]) => void) => {
    mocks.opened.add(listener);
    return () => { mocks.opened.delete(listener); };
  } } },
}));

beforeEach(() => {
  mocks.opened.clear();
  mocks.dropped.clear();
  mocks.take.mockReset().mockResolvedValue([]);
});

it("keeps Open With delivery when the active page stops accepting drops", async () => {
  mocks.take.mockResolvedValueOnce(["/launch.jpg"]);
  const opened = vi.fn();
  const dropped = vi.fn();
  const offOpen = onImagesOpened(opened);
  const offDrop = onFileDrop(dropped);
  await vi.waitFor(() => expect(opened).toHaveBeenCalledWith(["/launch.jpg"]));
  offDrop();
  mocks.opened.forEach((listener) => listener(["/settings.jpg"]));
  expect(opened).toHaveBeenLastCalledWith(["/settings.jpg"]);
  expect(dropped).not.toHaveBeenCalled();
  expect(mocks.dropped.size).toBe(0);
  offOpen();
  expect(mocks.opened.size).toBe(0);
});

it("subscribes before enabling live delivery and draining launch files", async () => {
  mocks.take.mockImplementationOnce(async () => {
    mocks.opened.forEach((listener) => listener(["/live.jpg"]));
    return ["/launch.jpg"];
  });
  const listener = vi.fn();
  const offOpen = onImagesOpened(listener);
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
  expect(listener).toHaveBeenNthCalledWith(1, ["/live.jpg"]);
  expect(listener).toHaveBeenNthCalledWith(2, ["/launch.jpg"]);
  offOpen();
});
