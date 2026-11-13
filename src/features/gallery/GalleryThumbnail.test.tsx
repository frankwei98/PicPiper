import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { galleryApi } from "@/api/backend";
import { GalleryThumbnail } from "./GalleryThumbnail";

vi.mock("@/api/backend", () => ({ galleryApi: { readThumbnail: vi.fn() } }));
const profile = { id: "a", name: "A", endpoint: "https://s3.example.test", bucket: "a", region: "auto", accessKeyId: "fake", pathStyle: true, defaultPrefix: "" };
const object = { key: "photo.png", etag: "v1", size: 100, isImage: true, publicUrl: "https://cdn.example.test/photo.png" };
beforeEach(() => { vi.resetAllMocks(); });

it("ignores a late thumbnail from the previous bucket", async () => {
  let finish!: (value: { dataUrl: string }) => void;
  vi.mocked(galleryApi.readThumbnail).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  vi.mocked(galleryApi.readThumbnail).mockResolvedValue({ dataUrl: "data:image/png;base64,NEW" });
  const { rerender } = render(<GalleryThumbnail profile={profile} object={object} onView={vi.fn()} />);
  await waitFor(() => expect(galleryApi.readThumbnail).toHaveBeenCalledTimes(1));
  rerender(<GalleryThumbnail profile={{ ...profile, bucket: "b" }} object={object} onView={vi.fn()} />);
  expect(await screen.findByRole("img")).toHaveAttribute("src", "data:image/png;base64,NEW");
  await act(async () => { finish({ dataUrl: "data:image/png;base64,OLD" }); });
  expect(screen.getByRole("img")).toHaveAttribute("src", "data:image/png;base64,NEW");
});

it("keeps failures as a placeholder without falling back to the public image", async () => {
  vi.mocked(galleryApi.readThumbnail).mockRejectedValue(new Error("offline"));
  render(<GalleryThumbnail profile={profile} object={object} onView={vi.fn()} />);
  await waitFor(() => expect(galleryApi.readThumbnail).toHaveBeenCalled());
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(await screen.findByText("Image")).toBeInTheDocument();
});

it("waits for a tile to approach the viewport before loading its thumbnail", async () => {
  let visible!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { visible = callback; }
    observe() {} disconnect = disconnect;
  });
  try {
    vi.mocked(galleryApi.readThumbnail).mockResolvedValue({ dataUrl: "data:image/png;base64,LOCAL" });
    render(<GalleryThumbnail profile={profile} object={object} onView={vi.fn()} />);
    expect(galleryApi.readThumbnail).not.toHaveBeenCalled();
    await act(async () => { visible([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); });
    expect(await screen.findByRole("img")).toHaveAttribute("src", "data:image/png;base64,LOCAL");
    expect(disconnect).toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it("covers both the cache request and browser image load with a skeleton", async () => {
  let finish!: (value: { dataUrl: string }) => void;
  vi.mocked(galleryApi.readThumbnail).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { container } = render(<GalleryThumbnail profile={profile} object={object} onView={vi.fn()} />);
  expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
  await act(async () => { finish({ dataUrl: "data:image/png;base64,LOCAL" }); });
  expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.load(screen.getByRole("img"));
  expect(container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument();
});
