import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { S3GalleryPage } from "./S3GalleryPage";

const { listObjects, deleteObject, downloadObject, mockDialogOpen, uploadObject, generateObjectKey, loadSettings } = vi.hoisted(() => {
  const mockDialogOpen = vi.fn(async () => "/tmp/downloads");
  return {
    listObjects: vi.fn(async () => [
      {
        key: "images/photo.webp",
        size: 240_000,
        publicUrl: "https://cdn.example.com/images/photo.webp",
        isImage: true,
      },
    ]),
    deleteObject: vi.fn(async () => {}),
    downloadObject: vi.fn(async () => "/tmp/downloads/photo.webp"),
    mockDialogOpen,
    uploadObject: vi.fn(async (req: { objectKey: string }) => ({
      key: req.objectKey,
      size: 100_000,
      publicUrl: `https://cdn.example.com/${req.objectKey}`,
      isImage: true,
    })),
    generateObjectKey: vi.fn(async (req: { outputFileName: string }) => ({
      objectKey: `images/2026/06/${req.outputFileName}`,
    })),
    loadSettings: vi.fn(async () => ({
      profiles: [],
      presets: [],
      namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
    })),
  };
});

vi.mock("@tauri-apps/plugin-dialog", async () => ({
  open: mockDialogOpen,
}));

vi.mock("../../api/tauri", async () => ({
  galleryApi: { listObjects, deleteObject, downloadObject },
  tauriApi: {},
  uploadApi: { uploadObject },
  namingApi: { generateObjectKey },
  settingsApi: { loadSettings },
}));

const profile = {
  id: "p1",
  name: "Personal S3",
  bucket: "images",
  endpoint: "https://s3.example.com",
  region: "auto",
  accessKeyId: "AKIAEXAMPLE",
  pathStyle: false,
  defaultPrefix: "2026/06",
  publicBaseUrl: "https://cdn.example.com",
  insecureSecretFallback: false,
};

describe("S3GalleryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listObjects.mockResolvedValue([
      {
        key: "images/photo.webp",
        size: 240_000,
        publicUrl: "https://cdn.example.com/images/photo.webp",
        isImage: true,
      },
    ]);
  });

  it("shows empty state when no profiles are passed", () => {
    render(<S3GalleryPage galleryFocus={{ prefix: "", highlightedKeys: [] }} profiles={[]} />);

    expect(screen.getByText(/no profile selected/i)).toBeInTheDocument();
    expect(screen.queryByText("images/photo.webp")).not.toBeInTheDocument();
  });

  it("loads objects for the selected profile and prefix", async () => {
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    expect(await screen.findByText("images/photo.webp")).toBeInTheDocument();
    expect(listObjects).toHaveBeenCalledWith({ profile, prefix: "images" });
  });

  it("renders img thumbnail for image objects with publicUrl", async () => {
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    const img = screen.getByRole("img", { name: "images/photo.webp" });
    expect(img).toHaveAttribute("src", "https://cdn.example.com/images/photo.webp");
    expect(img).toHaveAttribute("alt", "images/photo.webp");
  });

  it("falls back to placeholder text when publicUrl is missing", async () => {
    listObjects.mockResolvedValue([
      {
        key: "images/no-url.webp",
        size: 50_000,
        publicUrl: undefined as unknown as string,
        isImage: true,
      },
    ]);
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/no-url.webp");
    expect(screen.queryByRole("img", { name: "images/no-url.webp" })).not.toBeInTheDocument();
    expect(screen.getByText("Image")).toBeInTheDocument();
  });

  it("renders loading state while fetching objects", async () => {
    listObjects.mockImplementation(() => new Promise(() => {}));
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();
  });

  it("renders error state when listObjects fails", async () => {
    listObjects.mockRejectedValue(new Error("S3 connection failed"));
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    expect(await screen.findByText(/s3 connection failed/i)).toBeInTheDocument();
  });

  it("renders empty state when no objects returned", async () => {
    listObjects.mockResolvedValue([]);
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    expect(await screen.findByText(/no objects/i)).toBeInTheDocument();
  });

  it("deletes after confirmation and refreshes the prefix", async () => {
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /delete/i }));

    // Confirm in the AlertDialog
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /delete/i }));

    expect(deleteObject).toHaveBeenCalledWith({ profile, key: "images/photo.webp" });
    expect(listObjects).toHaveBeenCalledTimes(2);
  });

  it("does not delete when confirmation is cancelled", async () => {
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /delete/i }));

    // Cancel in the AlertDialog
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    expect(deleteObject).not.toHaveBeenCalled();
    expect(listObjects).toHaveBeenCalledTimes(1);
  });

  it("copies public URL to clipboard when Copy URL is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /copy url/i }));

    expect(writeText).toHaveBeenCalledWith("https://cdn.example.com/images/photo.webp");
  });

  it("shows error when Copy URL is clicked but publicBaseUrl is missing", async () => {
    listObjects.mockResolvedValue([
      {
        key: "images/photo.webp",
        size: 240_000,
        publicUrl: undefined as unknown as string,
        isImage: true,
      },
    ]);
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /copy url/i }));

    expect(screen.getByText(/public base url/i)).toBeInTheDocument();
  });

  it("opens public URL in new tab when View is clicked", async () => {
    const open = vi.fn();
    Object.assign(window, { open });
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /view/i }));

    expect(open).toHaveBeenCalledWith("https://cdn.example.com/images/photo.webp", "_blank");
  });

  it("downloads object to chosen directory", async () => {
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /download/i }));

    expect(mockDialogOpen).toHaveBeenCalledWith({ directory: true });
    expect(downloadObject).toHaveBeenCalledWith({
      profile,
      key: "images/photo.webp",
      outputPath: "/tmp/downloads/photo.webp",
    });
  });

  it("does not show rename or move buttons", async () => {
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    expect(screen.queryByText(/rename/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/move/i)).not.toBeInTheDocument();
  });

  it("switches profile via select and reloads objects with new profile's defaultPrefix", async () => {
    const profile2 = {
      ...profile,
      id: "p2",
      name: "Work S3",
      defaultPrefix: "work/images",
    };
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ profile, prefix: "", highlightedKeys: [] }}
        profiles={[profile, profile2]}
      />,
    );

    // Initial load uses profile 1 with its defaultPrefix
    await screen.findByText("images/photo.webp");
    expect(listObjects).toHaveBeenCalledWith({ profile, prefix: "2026/06" });

    // Switch to profile 2
    const select = screen.getByRole("combobox", { name: /profile/i });
    await user.selectOptions(select, "p2");

    // Should reload with profile 2 and its defaultPrefix
    expect(listObjects).toHaveBeenCalledWith({ profile: profile2, prefix: "work/images" });
  });

  it("upload local images calls generateObjectKey and uploadObject, then refreshes", async () => {
    mockDialogOpen.mockResolvedValueOnce(["/tmp/new-photo.jpg"] as unknown as string);
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");

    await user.click(screen.getByRole("button", { name: /upload local images/i }));

    expect(mockDialogOpen).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: true }),
    );
    expect(generateObjectKey).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: "/tmp/new-photo.jpg",
        outputFileName: "new-photo.jpg",
        namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
      }),
    );
    expect(uploadObject).toHaveBeenCalledWith(
      expect.objectContaining({
        profile,
        sourcePath: "/tmp/new-photo.jpg",
      }),
    );
    // Should refresh the object list after upload
    expect(listObjects).toHaveBeenCalledTimes(2);
  });
});
