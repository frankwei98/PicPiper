import { render, screen, within, act, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { S3GalleryPage } from "./S3GalleryPage";
import { fileNameFromPath } from "../../lib/path";

const { readThumbnail, listObjects, deleteObject, downloadObject, mockDialogOpen, mockOpenUrl, mockWriteClipboard, uploadObject, generateObjectKey, loadSettings } = vi.hoisted(() => {
  const mockDialogOpen = vi.fn(async () => "/tmp/downloads");
  return {
    readThumbnail: vi.fn(async () => ({ dataUrl: "data:image/png;base64,LOCAL" })),
    listObjects: vi.fn(async (_request?: unknown): Promise<unknown> => ({
      objects: [
        {
          key: "images/photo.webp",
          size: 240_000,
          publicUrl: "https://cdn.example.com/images/photo.webp",
          isImage: true,
        },
      ],
      nextContinuationToken: null,
    })),
    deleteObject: vi.fn(async () => {}),
    downloadObject: vi.fn(async () => "/tmp/downloads/photo.webp"),
    mockDialogOpen,
    mockOpenUrl: vi.fn(async () => {}),
    mockWriteClipboard: vi.fn(async () => {}),
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
      namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
    })),
  };
});

vi.mock("@/platform/desktop", async () => ({
  open: mockDialogOpen,
  openUrl: mockOpenUrl,
  writeClipboard: mockWriteClipboard,
}));

vi.mock("../../api/backend", async () => ({
  galleryApi: { readThumbnail, listObjects, deleteObject, downloadObject },
  imageApi: {},
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
};

describe("S3GalleryPage", () => {
  it("filters only loaded records, clears active filters and switches the presentation without refetching", async () => {
    const user = userEvent.setup();
    listObjects.mockResolvedValueOnce({ objects: [
      { key: "images/photo.webp", size: 240_000, isImage: true, publicUrl: "https://cdn.example.com/photo.webp" },
      { key: "images/logo.png", size: 800_000, isImage: true, publicUrl: "https://cdn.example.com/logo.png" },
    ], nextContinuationToken: null });
    render(<S3GalleryPage profiles={[profile]} galleryFocus={{ prefix: "", highlightedKeys: [] }} />);
    await screen.findByText("images/logo.png");
    expect(screen.queryByRole("combobox", { name: "File size" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Format" }), "png");
    expect(screen.queryByText("images/photo.webp")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 2 images")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "PNG" }));
    expect(screen.getByText("images/photo.webp")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.getByRole("button", { name: "Grid view" })).toBeVisible();
    expect(listObjects).toHaveBeenCalledTimes(1);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    listObjects.mockResolvedValue({
      objects: [
        {
          key: "images/photo.webp",
          size: 240_000,
          publicUrl: "https://cdn.example.com/images/photo.webp",
          isImage: true,
        },
      ],
      nextContinuationToken: null,
    });
  });

  it("extracts filenames from POSIX and Windows picker paths", () => {
    expect(fileNameFromPath("/Users/alice/photo.jpg")).toBe("photo.jpg");
    expect(fileNameFromPath("C:\\Users\\alice\\photo.jpg")).toBe("photo.jpg");
    expect(fileNameFromPath("\\\\server\\share\\photo.jpg")).toBe("photo.jpg");
    expect(fileNameFromPath("photo.jpg")).toBe("photo.jpg");
    expect(fileNameFromPath("C:\\Users\\alice\\")).toBe("image");
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
    expect(screen.queryByText(/Unverified objects hidden:/)).not.toBeInTheDocument();
  });

  it("reloads the full scope with the selected order and carries it into pagination", async () => {
    listObjects.mockResolvedValueOnce({ objects: [{ key: "old.png", size: 1, isImage: true }], nextContinuationToken: "old-cursor" });
    listObjects.mockResolvedValueOnce({ objects: [{ key: "alpha.png", size: 1, isImage: true }], nextContinuationToken: "name-cursor" });
    listObjects.mockResolvedValueOnce({ objects: [{ key: "zulu.png", size: 1, isImage: true }], nextContinuationToken: null });
    render(<S3GalleryPage galleryFocus={{ prefix: "images", highlightedKeys: [] }} profiles={[profile]} />);
    await screen.findByText("old.png");
    const user = userEvent.setup();
    expect(screen.getByRole("combobox", { name: "Sort by" })).toHaveValue("time-desc");
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort by" }), "name-asc");
    await screen.findByText("alpha.png");
    expect(screen.queryByText("old.png")).not.toBeInTheDocument();
    expect(listObjects).toHaveBeenNthCalledWith(2, { profile, prefix: "images", sort: "name-asc" });
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("zulu.png");
    expect(listObjects).toHaveBeenNthCalledWith(3, { profile, prefix: "images", sort: "name-asc", continuationToken: "name-cursor" });
    expect(Array.from(document.querySelectorAll(".proof-key"), (node) => node.textContent)).toEqual(["alpha.png", "zulu.png"]);
  });

  it("keeps the selected ordering when a new upload precedes loading another page", async () => {
    const alpha = { key: "images/alpha.png", fileName: "Alpha.png", size: 1, isImage: true };
    const middle = { key: "images/middle.png", fileName: "Middle.png", size: 1, isImage: true };
    listObjects.mockResolvedValueOnce({ objects: [alpha], nextContinuationToken: "time-cursor" });
    listObjects.mockResolvedValueOnce({ objects: [alpha], nextContinuationToken: "name-cursor" });
    listObjects.mockResolvedValueOnce({ objects: [middle], nextContinuationToken: null });
    const zulu = { key: "images/zulu.png", fileName: "Zulu.png", size: 1, isImage: true, publicUrl: "https://cdn.example.com/images/zulu.png" };
    uploadObject.mockResolvedValueOnce(zulu);
    mockDialogOpen.mockResolvedValueOnce("/tmp/Zulu.png");
    render(<S3GalleryPage galleryFocus={{ prefix: "images", highlightedKeys: [] }} profiles={[profile]} />);
    const user = userEvent.setup();
    await screen.findByText(alpha.key);
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort by" }), "name-asc");
    await waitFor(() => expect(listObjects).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Upload local images" }));
    await screen.findByText(zulu.key);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText(middle.key);
    expect(Array.from(document.querySelectorAll(".proof-key"), (node) => node.textContent)).toEqual([alpha.key, middle.key, zulu.key]);
  });

  it("keeps a successful upload successful while showing a local history persistence warning", async () => {
    mockDialogOpen.mockResolvedValueOnce("/tmp/photo.png");
    const uploaded = { key: "images/photo.png", size: 100, isImage: true, publicUrl: "https://cdn.example.com/images/photo.png", uploadRecordWarning: true };
    uploadObject.mockResolvedValueOnce(uploaded);
    render(<S3GalleryPage galleryFocus={{ prefix: "images", highlightedKeys: [] }} profiles={[profile]} />);
    await screen.findByText("images/photo.webp");
    await userEvent.setup().click(screen.getByRole("button", { name: "Upload local images" }));
    expect(await screen.findByText(/Could not save the local upload record/)).toHaveTextContent("Uploaded 1 image(s).");
    expect(uploadObject).toHaveBeenCalledTimes(1);
  });

  it("loads another bounded page when the continuation token is requested", async () => {
    const user = userEvent.setup();
    listObjects
      .mockResolvedValueOnce({
        objects: [
          {
            key: "images/page-one.webp",
            size: 100,
            publicUrl: "https://cdn.example.com/images/page-one.webp",
            isImage: true,
          },
        ],
        nextContinuationToken: "page-2",
      })
      .mockResolvedValueOnce({
        objects: [
          {
            key: "images/page-two.webp",
            size: 200,
            publicUrl: "https://cdn.example.com/images/page-two.webp",
            isImage: true,
          },
        ],
        nextContinuationToken: null,
      });

    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    expect(await screen.findByText("images/page-one.webp")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("images/page-two.webp")).toBeInTheDocument();
    expect(listObjects).toHaveBeenNthCalledWith(2, {
      profile,
      prefix: "images",
      continuationToken: "page-2",
    });
    expect(screen.getByText("images/page-one.webp")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("accumulates unverified counts across pages and refresh resets the warning", async () => {
    listObjects
      .mockResolvedValueOnce({ objects: [{ key: "page-one.png", size: 1, isImage: true }], nextContinuationToken: "next", unverifiedCount: 2 })
      .mockResolvedValueOnce({ objects: [{ key: "page-two.png", size: 1, isImage: true }], nextContinuationToken: null, unverifiedCount: 3 })
      .mockResolvedValueOnce({ objects: [{ key: "page-one.png", size: 1, isImage: true }], nextContinuationToken: null, unverifiedCount: 1 });
    const user = userEvent.setup();
    render(<S3GalleryPage galleryFocus={{ prefix: "images", highlightedKeys: [] }} profiles={[profile]} />);

    await screen.findByText("page-one.png");
    expect(await screen.findByText("Unverified objects hidden: 2.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("page-two.png");
    expect(screen.getByText("Unverified objects hidden: 5.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh to retry" }));
    await waitFor(() => expect(listObjects).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Unverified objects hidden: 1.")).toBeInTheDocument();
  });

  it("shows an unverified warning even when the page has no verified objects", async () => {
    listObjects.mockResolvedValueOnce({ objects: [], nextContinuationToken: null, unverifiedCount: 4 });
    render(<S3GalleryPage galleryFocus={{ prefix: "images", highlightedKeys: [] }} profiles={[profile]} />);

    expect(await screen.findByText("No objects found.")).toBeInTheDocument();
    expect(screen.getByText("Unverified objects hidden: 4.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh to retry" })).toBeInTheDocument();
  });

  it("does not let an old scope response replace the current unverified count", async () => {
    const profile2 = { ...profile, id: "p2", name: "Work S3", defaultPrefix: "work/images" };
    const requests: Array<{ resolve: (value: unknown) => void }> = [];
    listObjects.mockImplementation(() => new Promise((resolve) => { requests.push({ resolve }); }));
    const user = userEvent.setup();
    render(<S3GalleryPage galleryFocus={{ profileId: "p1", prefix: "images", highlightedKeys: [] }} profiles={[profile, profile2]} />);
    await waitFor(() => expect(requests).toHaveLength(1));
    await user.selectOptions(screen.getByRole("combobox", { name: "Profile" }), "p2");
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => requests[1]!.resolve({ objects: [{ key: "work/images/current.png", size: 1, isImage: true }], unverifiedCount: 1 }));
    await screen.findByText("work/images/current.png");
    await act(async () => requests[0]!.resolve({ objects: [], unverifiedCount: 9 }));
    expect(screen.getByText("Unverified objects hidden: 1.")).toBeInTheDocument();
    expect(screen.queryByText("Unverified objects hidden: 9.")).not.toBeInTheDocument();
  });

  it("shows skeleton cards during pagination while keeping the loaded page", async () => {
    let finish!: (value: unknown) => void;
    listObjects.mockResolvedValueOnce({ objects: [{ key: "first.png", size: 100, isImage: true }], nextContinuationToken: "next" });
    listObjects.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { container } = render(<S3GalleryPage galleryFocus={{ prefix: "images", highlightedKeys: [] }} profiles={[profile]} />);
    await screen.findByText("first.png");
    await userEvent.setup().click(screen.getByRole("button", { name: "Load more" }));
    expect(screen.getByRole("status", { name: "Loading more..." }).querySelectorAll('[data-slot="skeleton"]')).toHaveLength(21);
    expect(screen.getByText("first.png")).toBeInTheDocument();
    await act(async () => { finish({ objects: [], nextContinuationToken: null }); });
    expect(screen.queryByRole("status", { name: "Loading more..." })).not.toBeInTheDocument();
    expect(container.querySelector(".contact-sheet")).toBeInTheDocument();
  });

  it("keeps loaded objects visible and offers a retry when loading another page fails", async () => {
    const user = userEvent.setup();
    listObjects
      .mockResolvedValueOnce({
        objects: [{ key: "images/page-one.webp", size: 100, isImage: true }],
        nextContinuationToken: "page-2",
      })
      .mockRejectedValueOnce(new Error("Temporary network error"))
      .mockResolvedValueOnce({
        objects: [{ key: "images/page-two.webp", size: 100, isImage: true }],
        nextContinuationToken: null,
      });

    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    expect(await screen.findByText("images/page-one.webp")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText(/failed to load more: temporary network error/i)).toBeInTheDocument();
    expect(screen.getByText("images/page-one.webp")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry load more" }));

    expect(await screen.findByText("images/page-two.webp")).toBeInTheDocument();
  });

  it("explains that search only covers the loaded pages", async () => {
    const user = userEvent.setup();
    listObjects.mockResolvedValueOnce({
      objects: [{ key: "images/page-one.webp", size: 100, isImage: true }],
      nextContinuationToken: "page-2",
    });
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/page-one.webp");
    await user.type(screen.getByLabelText("Search current prefix"), "later");

    expect(screen.getByText("No loaded objects match this search.")).toBeInTheDocument();
    expect(screen.getByText(/search only covers loaded objects/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
  });

  it("ignores a stale next-page response after changing gallery scope", async () => {
    const profile2 = {
      ...profile,
      id: "p2",
      name: "Work S3",
      defaultPrefix: "work/images",
    };
    const requests: Array<{
      profileId: string;
      continuationToken?: string;
      resolve: (value: unknown) => void;
    }> = [];
    listObjects.mockImplementation((request?: unknown) => {
      const typed = request as {
        profile: { id: string };
        continuationToken?: string;
      };
      return new Promise((resolve) => {
        requests.push({
          profileId: typed.profile.id,
          continuationToken: typed.continuationToken,
          resolve,
        });
      });
    });
    const user = userEvent.setup();

    render(
      <S3GalleryPage
        galleryFocus={{ profileId: "p1", prefix: "", highlightedKeys: [] }}
        profiles={[profile, profile2]}
      />,
    );

    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      requests[0]!.resolve({
        objects: [
          {
            key: "bucket-a/page-one.webp",
            size: 100,
            publicUrl: "https://cdn.example.com/bucket-a/page-one.webp",
            isImage: true,
          },
        ],
        nextContinuationToken: "page-2",
      });
    });
    expect(await screen.findByText("bucket-a/page-one.webp")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    await user.selectOptions(screen.getByRole("combobox", { name: /profile/i }), "p2");
    await waitFor(() => expect(requests).toHaveLength(3));

    await act(async () => {
      requests[2]!.resolve({
        objects: [
          {
            key: "bucket-b/current.webp",
            size: 200,
            publicUrl: "https://cdn.example.com/bucket-b/current.webp",
            isImage: true,
          },
        ],
        nextContinuationToken: null,
      });
    });
    expect(await screen.findByText("bucket-b/current.webp")).toBeInTheDocument();

    await act(async () => {
      requests[1]!.resolve({
        objects: [
          {
            key: "bucket-a/stale-page-two.webp",
            size: 300,
            publicUrl: "https://cdn.example.com/bucket-a/stale-page-two.webp",
            isImage: true,
          },
        ],
        nextContinuationToken: null,
      });
    });
    expect(screen.queryByText("bucket-a/stale-page-two.webp")).not.toBeInTheDocument();
    expect(requests[1]!.profileId).toBe("p1");
    expect(requests[1]!.continuationToken).toBe("page-2");
  });

  it("renders a cached thumbnail and opens the public URL only when clicked", async () => {
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    const img = await screen.findByRole("img", { name: "images/photo.webp" });
    expect(img).toHaveAttribute("src", "data:image/png;base64,LOCAL");
    expect(readThumbnail).toHaveBeenCalledWith(expect.objectContaining({ profile, key: "images/photo.webp" }));
    expect(mockOpenUrl).not.toHaveBeenCalled();
    await userEvent.setup().click(img);
    expect(mockOpenUrl).toHaveBeenCalledWith("https://cdn.example.com/images/photo.webp");
    expect(img).toHaveAttribute("alt", "images/photo.webp");
  });

  it("renders local thumbnails even without a public URL", async () => {
    listObjects.mockResolvedValue({
      objects: [
        {
          key: "images/no-url.webp",
          size: 50_000,
          publicUrl: undefined as unknown as string,
          isImage: true,
        },
      ],
      nextContinuationToken: null,
    });
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/no-url.webp");
    expect(await screen.findByRole("img", { name: "images/no-url.webp" })).toHaveAttribute("src", "data:image/png;base64,LOCAL");
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
    listObjects.mockResolvedValue({ objects: [], nextContinuationToken: null });
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    expect(await screen.findByText(/no objects/i)).toBeInTheDocument();
  });

  it("deletes after confirmation without discarding the loaded pages", async () => {
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
    expect(listObjects).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("images/photo.webp")).not.toBeInTheDocument();
  });

  it("shows an error when delete rejects", async () => {
    deleteObject.mockRejectedValueOnce(new Error("Access denied"));
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /delete/i }));

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /delete/i }));

    expect(await screen.findByText(/access denied/i)).toBeInTheDocument();
    // listObjects should only be called once (initial load), not refreshed after failed delete
    expect(listObjects).toHaveBeenCalledTimes(1);
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
    const writeText = mockWriteClipboard;
    writeText.mockClear();
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

  it("disables public URL actions and links to Settings when Public Base URL is missing", async () => {
    listObjects.mockResolvedValue({
      objects: [
        {
          key: "images/photo.webp",
          size: 240_000,
          publicUrl: undefined as unknown as string,
          isImage: true,
        },
      ],
      nextContinuationToken: null,
    });
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const profileWithoutPublicUrl = { ...profile, publicBaseUrl: undefined };
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profileWithoutPublicUrl]}
        onNavigate={onNavigate}
      />,
    );

    await screen.findByText("images/photo.webp");
    const copyButton = screen.getByRole("button", { name: /copy url/i });
    const viewButton = screen.getByRole("button", { name: /^view$/i });
    expect(copyButton).toBeDisabled();
    expect(viewButton).toBeDisabled();
    expect(copyButton).toHaveAccessibleDescription(/configure a public base url in settings/i);
    expect(screen.getByText(/public urls are unavailable for this profile/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /open settings/i }));
    expect(onNavigate).toHaveBeenCalledWith("settings");
    expect(mockOpenUrl).not.toHaveBeenCalled();
  });

  it("opens public URL via the opener plugin when View is clicked", async () => {
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /^view$/i }));

    expect(mockOpenUrl).toHaveBeenCalledWith("https://cdn.example.com/images/photo.webp");
  });

  it("downloads object to chosen directory and shows saved path", async () => {
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
      outputDir: "/tmp/downloads",
    });
    expect(await screen.findByText(/saved to \/tmp\/downloads\/photo\.webp/i)).toBeInTheDocument();
  });

  it("shows error when download fails", async () => {
    downloadObject.mockRejectedValueOnce(new Error("Network timeout"));
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /download/i }));

    expect(await screen.findByText(/network timeout/i)).toBeInTheDocument();
  });

  it("shows object key in delete error message", async () => {
    deleteObject.mockRejectedValueOnce(new Error("Access denied"));
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /delete/i }));

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /delete/i }));

    expect(await screen.findByText(/failed to delete images\/photo\.webp/i)).toBeInTheDocument();
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
        galleryFocus={{ profileId: "p1", prefix: "", highlightedKeys: [] }}
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

  it("shows New only in the profile and prefix that supplied the highlight", async () => {
    const profile2 = {
      ...profile,
      id: "p2",
      name: "Work S3",
      defaultPrefix: "work/images",
    };
    const sharedObject = {
      key: "shared/photo.webp",
      size: 240_000,
      publicUrl: "https://cdn.example.com/shared/photo.webp",
      isImage: true,
    };
    listObjects.mockResolvedValue({
      objects: [sharedObject],
      nextContinuationToken: null,
    });
    const user = userEvent.setup();
    const { unmount } = render(
      <S3GalleryPage
        galleryFocus={{
          profileId: "p1",
          prefix: "personal/images",
          highlightedKeys: [sharedObject.key],
        }}
        profiles={[profile, profile2]}
      />,
    );

    await screen.findByText(sharedObject.key);
    expect(screen.getByText("New")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: /profile/i }), "p2");
    await waitFor(() => {
      expect(listObjects).toHaveBeenCalledWith({ profile: profile2, prefix: "work/images" });
    });
    await waitFor(() => {
      expect(screen.queryByText("New")).not.toBeInTheDocument();
    });

    unmount();
    render(
      <S3GalleryPage
        galleryFocus={{
          profileId: "p2",
          prefix: "work/images",
          highlightedKeys: [sharedObject.key],
        }}
        profiles={[profile, profile2]}
      />,
    );

    expect(await screen.findByText("New")).toBeInTheDocument();
  });

  it("ignores a stale object response after switching profiles", async () => {
    const profile2 = {
      ...profile,
      id: "p2",
      name: "Work S3",
      defaultPrefix: "work/images",
    };
    const requests: Array<{
      profileId: string;
      resolve: (response: unknown) => void;
    }> = [];
    listObjects.mockImplementation((request?: unknown) => {
      const profileId = (request as { profile?: { id?: string } } | undefined)?.profile?.id;
      if (!profileId) return Promise.reject(new Error("Missing profile"));
      return new Promise((resolve) => {
        requests.push({ profileId, resolve });
      });
    });
    const user = userEvent.setup();

    render(
      <S3GalleryPage
        galleryFocus={{ profileId: "p1", prefix: "", highlightedKeys: [] }}
        profiles={[profile, profile2]}
      />,
    );

    await waitFor(() => expect(requests).toHaveLength(1));
    await user.selectOptions(screen.getByRole("combobox", { name: /profile/i }), "p2");
    await waitFor(() => expect(requests).toHaveLength(2));

    await act(async () => {
      requests[1]!.resolve({
        objects: [
          {
            key: "bucket-b/current.webp",
            size: 200,
            publicUrl: "https://cdn.example.com/bucket-b/current.webp",
            isImage: true,
          },
        ],
        nextContinuationToken: null,
      });
    });
    expect(await screen.findByText("bucket-b/current.webp")).toBeInTheDocument();

    await act(async () => {
      requests[0]!.resolve({
        objects: [
          {
            key: "bucket-a/late.webp",
            size: 300,
            publicUrl: "https://cdn.example.com/bucket-a/late.webp",
            isImage: true,
          },
        ],
        nextContinuationToken: null,
      });
    });

    expect(screen.queryByText("bucket-a/late.webp")).not.toBeInTheDocument();
    expect(screen.getByText("bucket-b/current.webp")).toBeInTheDocument();
  });

  it("does not expose the previous profile's object actions while reloading", async () => {
    const profile2 = {
      ...profile,
      id: "p2",
      name: "Work S3",
      defaultPrefix: "work/images",
    };
    let resolveProfile2: ((objects: unknown) => void) | undefined;
    listObjects
      .mockResolvedValueOnce({
        objects: [
          {
            key: "bucket-a/photo.webp",
            size: 100,
            publicUrl: "https://cdn.example.com/bucket-a/photo.webp",
            isImage: true,
          },
        ],
        nextContinuationToken: null,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveProfile2 = resolve;
          }),
      );
    const user = userEvent.setup();

    render(
      <S3GalleryPage
        galleryFocus={{ profileId: "p1", prefix: "", highlightedKeys: [] }}
        profiles={[profile, profile2]}
      />,
    );

    await screen.findByText("bucket-a/photo.webp");
    await user.selectOptions(screen.getByRole("combobox", { name: /profile/i }), "p2");
    await waitFor(() => expect(listObjects).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();

    await act(async () => {
      resolveProfile2?.({ objects: [], nextContinuationToken: null });
    });
  });

  it("ignores a stale list failure after a newer scope succeeds", async () => {
    const profile2 = {
      ...profile,
      id: "p2",
      name: "Work S3",
      defaultPrefix: "work/images",
    };
    const requests: Array<{
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
    }> = [];
    listObjects.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          requests.push({ resolve, reject });
        }),
    );
    const user = userEvent.setup();

    render(
      <S3GalleryPage
        galleryFocus={{ profileId: "p1", prefix: "", highlightedKeys: [] }}
        profiles={[profile, profile2]}
      />,
    );

    await waitFor(() => expect(requests).toHaveLength(1));
    await user.selectOptions(screen.getByRole("combobox", { name: /profile/i }), "p2");
    await waitFor(() => expect(requests).toHaveLength(2));

    await act(async () => {
      requests[1]!.resolve({
        objects: [
          {
            key: "bucket-b/current.webp",
            size: 200,
            publicUrl: "https://cdn.example.com/bucket-b/current.webp",
            isImage: true,
          },
        ],
        nextContinuationToken: null,
      });
    });
    expect(await screen.findByText("bucket-b/current.webp")).toBeInTheDocument();

    await act(async () => {
      requests[0]!.reject(new Error("stale profile failed"));
    });
    expect(screen.queryByText(/stale profile failed/i)).not.toBeInTheDocument();
    expect(screen.getByText("bucket-b/current.webp")).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
  });

  it("refreshes unchanged scopes for each external upload notification, including repeated keys", async () => {
    const profiles = [profile];
    const galleryFocus = { profileId: profile.id, prefix: "images", highlightedKeys: [] as string[] };
    const { rerender } = render(<S3GalleryPage galleryFocus={galleryFocus} profiles={profiles} />);
    await screen.findByText("images/photo.webp");
    expect(listObjects).toHaveBeenCalledTimes(1);

    for (const key of ["images/new.png", "images/new.png"]) {
      listObjects.mockResolvedValueOnce({ objects: [{ key, size: 100, isImage: true }], nextContinuationToken: null });
      const previousCalls = listObjects.mock.calls.length;
      rerender(<S3GalleryPage galleryFocus={{ ...galleryFocus, highlightedKeys: [key] }} profiles={profiles} />);
      await waitFor(() => expect(listObjects).toHaveBeenCalledTimes(previousCalls + 1));
      expect(await screen.findByText(key)).toBeInTheDocument();
      expect(screen.getByText("New")).toBeInTheDocument();
      expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
    }
  });

  it("keeps a loaded default scope ready when the profiles array changes without changing its entries", async () => {
    const galleryFocus = { prefix: "", highlightedKeys: [] };
    const { rerender } = render(<S3GalleryPage galleryFocus={galleryFocus} profiles={[profile]} />);
    await screen.findByText("images/photo.webp");

    rerender(<S3GalleryPage galleryFocus={galleryFocus} profiles={[profile]} />);

    expect(screen.getByText("images/photo.webp")).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
    expect(listObjects).toHaveBeenCalledTimes(1);
  });

  it("preserves an edited prefix when settings rerender with an unchanged external focus", async () => {
    const galleryFocus = { profileId: profile.id, prefix: "images", highlightedKeys: [] };
    const user = userEvent.setup();
    const { rerender } = render(<S3GalleryPage galleryFocus={galleryFocus} profiles={[profile]} />);
    await screen.findByText("images/photo.webp");
    await user.clear(screen.getByLabelText("Prefix"));
    await user.type(screen.getByLabelText("Prefix"), "edited/");
    await waitFor(() => expect(listObjects).toHaveBeenLastCalledWith({ profile, prefix: "edited/" }));
    await screen.findByText("images/photo.webp");

    rerender(<S3GalleryPage galleryFocus={galleryFocus} profiles={[profile]} />);

    expect(screen.getByLabelText("Prefix")).toHaveValue("edited/");
    expect(screen.getByText("images/photo.webp")).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
    expect(listObjects).toHaveBeenCalledTimes(2);
  });

  it("syncs selected profile when galleryFocus.profileId changes", async () => {
    const profile2 = {
      ...profile,
      id: "p2",
      name: "Work S3",
      defaultPrefix: "work/images",
    };
    const { rerender } = render(
      <S3GalleryPage
        galleryFocus={{ profileId: "p1", prefix: "", highlightedKeys: [] }}
        profiles={[profile, profile2]}
      />,
    );

    await screen.findByText("images/photo.webp");
    expect(listObjects).toHaveBeenCalledWith({ profile, prefix: "2026/06" });

    // Simulate external navigation changing the gallery focus
    rerender(
      <S3GalleryPage
        galleryFocus={{ profileId: "p2", prefix: "", highlightedKeys: [] }}
        profiles={[profile, profile2]}
      />,
    );

    expect(await screen.findByText("images/photo.webp")).toBeInTheDocument();
    expect(listObjects).toHaveBeenCalledWith({ profile: profile2, prefix: "work/images" });
  });

  it("does not refresh an old profile after a local upload finishes in a new scope", async () => {
    const profile2 = {
      ...profile,
      id: "p2",
      name: "Work S3",
      defaultPrefix: "work/images",
    };
    let resolveUpload!: (value: {
      key: string;
      size: number;
      publicUrl: string;
      isImage: boolean;
    }) => void;
    uploadObject.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    listObjects.mockImplementation(async (request?: unknown) => {
      const profileId = (request as { profile: { id: string } }).profile.id;
      return profileId === "p2"
        ? {
            objects: [{ key: "work/images/current.webp", size: 100, isImage: true }],
            nextContinuationToken: null,
          }
        : {
            objects: [{ key: "images/original.webp", size: 100, isImage: true }],
            nextContinuationToken: null,
          };
    });
    mockDialogOpen.mockResolvedValueOnce(["/tmp/new-photo.jpg"] as unknown as string);
    const user = userEvent.setup();

    render(
      <S3GalleryPage
        galleryFocus={{ profileId: "p1", prefix: "images", highlightedKeys: [] }}
        profiles={[profile, profile2]}
      />,
    );

    await screen.findByText("images/original.webp");
    const oldProfileRequests = listObjects.mock.calls.filter(
      ([request]) => (request as { profile: { id: string } }).profile.id === "p1",
    ).length;

    await user.click(screen.getByRole("button", { name: /upload local images/i }));
    await waitFor(() => expect(uploadObject).toHaveBeenCalledTimes(1));
    await user.selectOptions(screen.getByRole("combobox", { name: /profile/i }), "p2");
    expect(await screen.findByText("work/images/current.webp")).toBeInTheDocument();

    await act(async () => {
      resolveUpload!({
        key: "images/new-photo.jpg",
        size: 100,
        publicUrl: "https://cdn.example.com/images/new-photo.jpg",
        isImage: true,
      });
    });

    expect(screen.getByText("work/images/current.webp")).toBeInTheDocument();
    expect(
      listObjects.mock.calls.filter(
        ([request]) => (request as { profile: { id: string } }).profile.id === "p1",
      ),
    ).toHaveLength(oldProfileRequests);
  });

  it.each([false, true])("preserves uploads and their fresh metadata when an in-flight first page has a stale duplicate: %s", async (includesStaleDuplicate) => {
    let finishListing!: (value: unknown) => void;
    listObjects.mockImplementationOnce(() => new Promise((resolve) => { finishListing = resolve; }));
    const uploaded = {
      key: "images/new.png",
      fileName: "Fresh local upload.png",
      size: 300,
      isImage: true,
      publicUrl: "https://cdn.example.com/images/fresh.png",
    };
    uploadObject.mockResolvedValueOnce(uploaded);
    mockDialogOpen.mockResolvedValueOnce("/tmp/new.png");
    const galleryFocus = { profileId: profile.id, prefix: "images", highlightedKeys: [] };
    const profiles = [profile];
    const user = userEvent.setup();
    const { rerender } = render(<S3GalleryPage galleryFocus={galleryFocus} profiles={profiles} />);
    await waitFor(() => expect(listObjects).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Upload local images" }));
    await screen.findByText("Uploaded 1 image(s).");
    await act(async () => finishListing({
      objects: [
        { key: "images/existing.png", size: 100, isImage: true },
        ...(includesStaleDuplicate ? [{ ...uploaded, fileName: "Stale listing.png", publicUrl: "https://cdn.example.com/images/stale.png" }] : []),
      ],
      nextContinuationToken: null,
    }));

    expect(await screen.findByText(uploaded.fileName)).toBeInTheDocument();
    expect(screen.getAllByText(uploaded.key)).toHaveLength(1);
    expect(screen.getByText("images/existing.png")).toBeInTheDocument();
    expect(screen.queryByText("Stale listing.png")).not.toBeInTheDocument();
    const uploadedCard = screen.getByText(uploaded.key).closest("li")!;
    await user.click(within(uploadedCard).getByRole("button", { name: "Copy URL" }));
    expect(mockWriteClipboard).toHaveBeenLastCalledWith(uploaded.publicUrl);

    listObjects.mockResolvedValueOnce({ objects: [], nextContinuationToken: null });
    rerender(<S3GalleryPage galleryFocus={{ ...galleryFocus, highlightedKeys: [] }} profiles={profiles} />);
    await screen.findByText("No objects found.");
    expect(screen.queryByText(uploaded.key)).not.toBeInTheDocument();
  });

  it("keeps an upload for an edited prefix out of the previous prefix's pending listing", async () => {
    vi.useFakeTimers();
    try {
      let finishOldListing!: (value: unknown) => void;
      listObjects.mockImplementationOnce(() => new Promise((resolve) => { finishOldListing = resolve; }));
      const uploaded = { key: "edited/local.png", size: 300, isImage: true, publicUrl: "https://cdn.example.com/edited/local.png" };
      uploadObject.mockResolvedValueOnce(uploaded);
      mockDialogOpen.mockResolvedValueOnce("/tmp/local.png");
      render(<S3GalleryPage galleryFocus={{ profileId: profile.id, prefix: "images", highlightedKeys: [] }} profiles={[profile]} />);
      expect(listObjects).toHaveBeenCalledTimes(1);
      fireEvent.change(screen.getByLabelText("Prefix"), { target: { value: "edited/" } });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Upload local images" })); });
      expect(screen.getByText("Uploaded 1 image(s).")).toBeInTheDocument();
      expect(listObjects).toHaveBeenCalledTimes(1);
      await act(async () => finishOldListing({ objects: [], nextContinuationToken: null }));

      fireEvent.change(screen.getByLabelText("Prefix"), { target: { value: "images" } });
      expect(screen.getByText("No objects found.")).toBeInTheDocument();
      expect(screen.queryByText(uploaded.key)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not carry an upload from a pending first page into another profile with the same prefix", async () => {
    let finishOldListing!: (value: unknown) => void;
    let finishNewListing!: (value: unknown) => void;
    listObjects
      .mockImplementationOnce(() => new Promise((resolve) => { finishOldListing = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishNewListing = resolve; }));
    const profile2 = { ...profile, id: "p2", name: "Work S3", defaultPrefix: "images" };
    const uploaded = { key: "images/local.png", size: 300, isImage: true, publicUrl: "https://cdn.example.com/images/local.png" };
    uploadObject.mockResolvedValueOnce(uploaded);
    mockDialogOpen.mockResolvedValueOnce("/tmp/local.png");
    const user = userEvent.setup();
    render(<S3GalleryPage galleryFocus={{ profileId: profile.id, prefix: "images", highlightedKeys: [] }} profiles={[profile, profile2]} />);
    await waitFor(() => expect(listObjects).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Upload local images" }));
    await screen.findByText("Uploaded 1 image(s).");
    await user.selectOptions(screen.getByRole("combobox", { name: "Profile" }), profile2.id);
    await waitFor(() => expect(listObjects).toHaveBeenCalledTimes(2));
    await act(async () => finishNewListing({ objects: [{ key: "images/work.png", size: 100, isImage: true }], nextContinuationToken: null }));
    await screen.findByText("images/work.png");
    await act(async () => finishOldListing({ objects: [uploaded], nextContinuationToken: null }));

    expect(screen.queryByText(uploaded.key)).not.toBeInTheDocument();
    expect(screen.getByText("images/work.png")).toBeInTheDocument();
    expect(screen.getByText("1 of 1 images")).toBeInTheDocument();
  });

  it("adds a local upload without discarding the loaded pages", async () => {
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

    expect(mockDialogOpen).toHaveBeenCalledWith({
      multiple: true,
      filters: [
        { name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "avif", "jxl", "heif", "heic"] },
      ],
    });
    expect(generateObjectKey).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: "/tmp/new-photo.jpg",
        outputFileName: "new-photo.jpg",
        prefix: "2026/06",
        namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
      }),
    );
    expect(uploadObject).toHaveBeenCalledWith(
      expect.objectContaining({
        profile,
        sourcePath: "/tmp/new-photo.jpg",
      }),
    );
    expect(listObjects).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("images/2026/06/new-photo.jpg")).toBeInTheDocument();
    expect(screen.getByText("images/photo.webp")).toBeInTheDocument();
  });

  it("keeps an empty profile upload prefix instead of using the gallery filter", async () => {
    mockDialogOpen.mockResolvedValueOnce(["/tmp/new-photo.jpg"] as unknown as string);
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[{ ...profile, defaultPrefix: "" }]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /upload local images/i }));

    await waitFor(() => expect(generateObjectKey).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "" }),
    ));
  });

  it("keeps uploads outside the current gallery prefix out of the visible results", async () => {
    mockDialogOpen.mockResolvedValueOnce(["/tmp/new-photo.jpg"] as unknown as string);
    generateObjectKey.mockResolvedValueOnce({ objectKey: "2026/06/outside.webp" });
    uploadObject.mockResolvedValueOnce({ key: "2026/06/outside.webp", size: 12, isImage: true, publicUrl: "https://cdn.example.test/2026/06/outside.webp" });
    render(<S3GalleryPage galleryFocus={{ prefix: "images", highlightedKeys: [] }} profiles={[profile]} />);
    await screen.findByText("images/photo.webp");
    await userEvent.setup().click(screen.getByRole("button", { name: /upload local images/i }));
    await screen.findByText("Uploaded 1 image(s).");
    expect(screen.queryByText("2026/06/outside.webp")).not.toBeInTheDocument();
    expect(screen.getByText("images/photo.webp")).toBeInTheDocument();
  });

  it("reports partial success without discarding the loaded pages", async () => {
    mockDialogOpen.mockResolvedValueOnce([
      "/tmp/first-photo.jpg",
      "/tmp/second-photo.jpg",
    ] as unknown as string);
    uploadObject
      .mockResolvedValueOnce({
        key: "images/first-photo.jpg",
        size: 100,
        publicUrl: "https://cdn.example.com/images/first-photo.jpg",
        isImage: true,
      })
      .mockRejectedValueOnce(new Error("Access denied"));
    const user = userEvent.setup();

    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /upload local images/i }));

    expect(uploadObject).toHaveBeenCalledTimes(2);
    expect(listObjects).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/uploaded 1 image\(s\); 1 failed/i)).toBeInTheDocument();
    expect(screen.getByText(/second-photo\.jpg: access denied/i)).toBeInTheDocument();
    expect(screen.getByText("images/first-photo.jpg")).toBeInTheDocument();
  });

  it("continues uploading when the first local file fails", async () => {
    mockDialogOpen.mockResolvedValueOnce([
      "/tmp/first-photo.jpg",
      "/tmp/second-photo.jpg",
    ] as unknown as string);
    uploadObject
      .mockRejectedValueOnce(new Error("Access denied"))
      .mockResolvedValueOnce({
        key: "images/second-photo.jpg",
        size: 100,
        publicUrl: "https://cdn.example.com/images/second-photo.jpg",
        isImage: true,
      });
    const user = userEvent.setup();

    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /upload local images/i }));

    expect(uploadObject).toHaveBeenCalledTimes(2);
    expect(listObjects).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/uploaded 1 image\(s\); 1 failed/i)).toBeInTheDocument();
    expect(screen.getByText(/first-photo\.jpg: access denied/i)).toBeInTheDocument();
    expect(screen.getByText("images/second-photo.jpg")).toBeInTheDocument();
  });

  it("reports all failures without pretending a refresh succeeded", async () => {
    mockDialogOpen.mockResolvedValueOnce([
      "/tmp/first-photo.jpg",
      "/tmp/second-photo.jpg",
    ] as unknown as string);
    uploadObject
      .mockRejectedValueOnce(new Error("Access denied"))
      .mockRejectedValueOnce(new Error("Network timeout"));
    const user = userEvent.setup();

    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /upload local images/i }));

    expect(uploadObject).toHaveBeenCalledTimes(2);
    expect(listObjects).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/uploaded 0 image\(s\); 2 failed/i)).toBeInTheDocument();
    expect(screen.getByText(/second-photo\.jpg: network timeout/i)).toBeInTheDocument();
  });

  it("shows the message from a serialized backend upload error", async () => {
    mockDialogOpen.mockResolvedValueOnce(["/tmp/conflict.jpg"] as unknown as string);
    uploadObject.mockRejectedValueOnce({
      code: "objectAlreadyExists",
      message: "An object with this key already exists.",
      recoverable: true,
    });
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /upload local images/i }));

    expect(
      await screen.findByText(/conflict\.jpg: an object with this key already exists/i),
    ).toBeInTheDocument();
  });

  it("uses image/heic content type for .heic uploads", async () => {
    mockDialogOpen.mockResolvedValueOnce(["/tmp/photo.heic"] as unknown as string);
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /upload local images/i }));

    expect(uploadObject).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "image/heic",
      }),
    );
  });

  it("lowercases extension before looking up content type for .HEIC uploads", async () => {
    mockDialogOpen.mockResolvedValueOnce(["/tmp/photo.HEIC"] as unknown as string);
    const user = userEvent.setup();
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /upload local images/i }));

    expect(uploadObject).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "image/heic",
      }),
    );
    const lastCall = uploadObject.mock.calls[uploadObject.mock.calls.length - 1] as unknown as
      | [{ contentType?: string }]
      | undefined;
    expect(lastCall?.[0]?.contentType).not.toBe("application/octet-stream");
  });

  it("auto-clears copyMessage after a few seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = mockWriteClipboard;
    writeText.mockClear();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    await user.click(screen.getByRole("button", { name: /copy url/i }));
    expect(await screen.findByText("URL copied")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByText("URL copied")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("uses defaultProfileId when galleryFocus.profileId is not set", async () => {
    const profile2 = {
      ...profile,
      id: "p2",
      name: "Work S3",
      defaultPrefix: "work/images",
    };
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "", highlightedKeys: [] }}
        profiles={[profile, profile2]}
        defaultProfileId="p2"
      />,
    );

    await screen.findByText("images/photo.webp");
    // Should use profile2 (the default) not profile (the first)
    expect(listObjects).toHaveBeenCalledWith({ profile: profile2, prefix: "work/images" });
  });

  it("adopts asynchronously loaded defaults until the user edits the gallery scope", async () => {
    const profile2 = {
      ...profile,
      id: "p2",
      name: "Work S3",
      defaultPrefix: "work/images",
    };
    const galleryFocus = { prefix: "", highlightedKeys: [] };
    const user = userEvent.setup();
    const { rerender } = render(
      <S3GalleryPage galleryFocus={galleryFocus} profiles={[]} />,
    );

    rerender(
      <S3GalleryPage
        galleryFocus={galleryFocus}
        profiles={[profile, profile2]}
        defaultProfileId="p2"
      />,
    );

    await waitFor(() => {
      expect(listObjects).toHaveBeenCalledWith({ profile: profile2, prefix: "work/images" });
    });

    await user.selectOptions(screen.getByRole("combobox", { name: /profile/i }), "p1");
    const prefixInput = screen.getByLabelText("Prefix");
    await user.clear(prefixInput);
    await user.type(prefixInput, "personal/edited");
    await waitFor(() => {
      expect(listObjects).toHaveBeenCalledWith({ profile, prefix: "personal/edited" });
    });

    rerender(
      <S3GalleryPage
        galleryFocus={galleryFocus}
        profiles={[{ ...profile }, { ...profile2 }]}
        defaultProfileId="p2"
      />,
    );

    expect(screen.getByRole("combobox", { name: /profile/i })).toHaveValue("p1");
    expect(prefixInput).toHaveValue("personal/edited");
  });

  it("debounces prefix changes and only calls listObjects once", async () => {
    // Use shouldAdvanceTime so timers auto-advance for Testing Library
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    // findByText needs timer advancement
    await screen.findByText("images/photo.webp");

    const initialCalls = listObjects.mock.calls.length;

    // Type multiple characters quickly
    const prefixInput = screen.getByLabelText("Prefix");
    await user.type(prefixInput, "images/20");

    // listObjects should not have been called again yet (debounced)
    expect(listObjects).toHaveBeenCalledTimes(initialCalls);

    // Advance timers past the debounce period (350ms)
    act(() => {
      vi.advanceTimersByTime(400);
    });

    // Now listObjects should have been called once more
    expect(listObjects).toHaveBeenCalledTimes(initialCalls + 1);

    vi.useRealTimers();
  });

  it("keeps the settled gallery visible when a prefix edit is reverted before debounce", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <S3GalleryPage
        galleryFocus={{ prefix: "images", highlightedKeys: [] }}
        profiles={[profile]}
      />,
    );

    await screen.findByText("images/photo.webp");
    const prefixInput = screen.getByLabelText("Prefix");
    await user.type(prefixInput, "-draft");
    await user.clear(prefixInput);
    await user.type(prefixInput, "images");

    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.getByText("images/photo.webp")).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
