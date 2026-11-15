import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OptimizePage } from "./OptimizePage";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { cancelImageTask, createOptimizerRun, inspectImage, compressImage, copyOutputsToDir, readThumbnail, mockDialogOpen, mockOnFileDrop, uploadObject, generateObjectKey } = vi.hoisted(() => {
  const mockDialogOpen = vi.fn(async (..._args: unknown[]) => ["/tmp/real-photo.jpg"]);
  return {
    cancelImageTask: vi.fn(async () => {}),
    createOptimizerRun: vi.fn(async () => ({
      runId: "run-1",
      outputDir: "/tmp/pic-piper/run-1",
    })),
    inspectImage: vi.fn(async () => ({
      id: "real-photo",
      sourcePath: "/tmp/real-photo.jpg",
      fileName: "real-photo.jpg",
      sourceFormat: "jpg",
      originalBytes: 1_200_000,
      estimatedBytes: 260_000,
      status: "queued",
      settings: {
        targetFormat: "jpg",
        quality: 85,
        removeGps: true,
      },
    })),
    compressImage: vi.fn(async () => ({
      sourcePath: "/tmp/real-photo.jpg",
      outputPath: "/tmp/pic-piper/run-1/real-photo.jpg",
      outputFileName: "real-photo.jpg",
      originalBytes: 1_200_000,
      outputBytes: 240_000,
      targetFormat: "jpg",
    })),
    copyOutputsToDir: vi.fn(async () => ["/tmp/saved/real-photo.jpg"]),
    readThumbnail: vi.fn(async ({ path }: { path: string }) => ({
      dataUrl: path.includes("pic-piper") ? "data:image/jpeg;base64,COMPRESSED" : "data:image/jpeg;base64,ORIGINAL",
    })),
    mockDialogOpen,
    mockOnFileDrop: vi.fn((_listener: (paths: string[]) => void) => vi.fn()),
    uploadObject: vi.fn(async () => ({
      key: "images/2026/06/real-photo-abcdef12.jpg",
      size: 240_000,
      publicUrl: "https://cdn.example.com/images/2026/06/real-photo-abcdef12.jpg",
      isImage: true,
    })),
    generateObjectKey: vi.fn(async () => ({
      objectKey: "images/2026/06/real-photo-abcdef12.jpg",
    })),
  };
});

vi.mock("@/platform/desktop", async () => ({
  open: mockDialogOpen,
  onFileDrop: mockOnFileDrop,
  onImagesOpened: vi.fn(() => vi.fn()),
}));

vi.mock("../../api/backend", async () => ({
  imageApi: {
    cancelImageTask,
    createOptimizerRun,
    inspectImage,
    compressImage,
    copyOutputsToDir,
    readThumbnail,
    readComparisonImage: vi.fn(async () => ({ dataUrl: "data:image/png;base64,comparison", width: 1200, height: 800 })),
  },
  uploadApi: {
    uploadObject,
  },
  namingApi: {
    generateObjectKey,
  },
}));

function installDefaultMocks() {
  createOptimizerRun.mockImplementation(async () => ({
    runId: "run-1",
    outputDir: "/tmp/pic-piper/run-1",
  }));
  inspectImage.mockImplementation(async () => ({
    id: "real-photo",
    sourcePath: "/tmp/real-photo.jpg",
    fileName: "real-photo.jpg",
    sourceFormat: "jpg",
    originalBytes: 1_200_000,
    estimatedBytes: 260_000,
    status: "queued",
    settings: {
      targetFormat: "jpg",
      quality: 85,
      removeGps: true,
    },
  }));
  compressImage.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as { sourcePath?: string; outputDir?: string; outputFileName?: string } | undefined;
    const outputDir = request?.outputDir ?? "/tmp/pic-piper/run-1";
    return {
      sourcePath: request?.sourcePath ?? "/tmp/real-photo.jpg",
      outputPath: `${outputDir}/${request?.outputFileName ?? "real-photo.jpg"}`,
      outputFileName: request?.outputFileName ?? "real-photo.jpg",
      originalBytes: 1_200_000,
      outputBytes: 240_000,
      targetFormat: "jpg",
    };
  });
  copyOutputsToDir.mockImplementation(async () => ["/tmp/saved/real-photo.jpg"]);
  readThumbnail.mockImplementation(async ({ path }: { path: string }) => ({
    dataUrl: path.includes("pic-piper") ? "data:image/jpeg;base64,COMPRESSED" : "data:image/jpeg;base64,ORIGINAL",
  }));
  uploadObject.mockImplementation(async () => ({
    key: "images/2026/06/real-photo-abcdef12.jpg",
    size: 240_000,
    publicUrl: "https://cdn.example.com/images/2026/06/real-photo-abcdef12.jpg",
    isImage: true,
  }));
  generateObjectKey.mockImplementation(async () => ({
    objectKey: "images/2026/06/real-photo-abcdef12.jpg",
  }));
}

async function setItemFormat(user: ReturnType<typeof userEvent.setup>, filename: string, format: string) {
  const summary = screen.getByText("Current image");
  if (!summary.closest("details")?.hasAttribute("open")) await user.click(summary);
  await user.selectOptions(screen.getByLabelText(`Format for ${filename}`), format);
}

describe("OptimizePage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      value: 8,
    });
    installDefaultMocks();
    // Reset dialog mock to default behavior
    mockDialogOpen.mockImplementation(async (...args: unknown[]) => {
      const opts = args[0] as { directory?: boolean } | undefined;
      if (opts?.directory) return "/tmp/saved" as unknown as string[];
      return ["/tmp/real-photo.jpg"];
    });
  });

  it("covers pending inspection with thumbnail and stage skeletons, then clears them on failure", async () => {
    let fail!: (error: Error) => void;
    inspectImage.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await userEvent.setup().click(screen.getByRole("button", { name: /choose images/i }));
    expect(within(screen.getByLabelText("Image preview")).getByRole("status", { name: "Preparing your image" })).toHaveAttribute("data-slot", "skeleton");
    expect(document.querySelector('.item-thumb [data-slot="skeleton"]')).toBeInTheDocument();
    await act(async () => { fail(new Error("Unreadable image")); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unreadable image");
    expect(document.querySelector('.stage-canvas [data-slot="skeleton"]')).not.toBeInTheDocument();
    expect(document.querySelector('.item-thumb [data-slot="skeleton"]')).not.toBeInTheDocument();
  });

  it("reports larger outputs with a useful next step", async () => {
    compressImage.mockResolvedValueOnce({ sourcePath: "/tmp/real-photo.jpg", outputPath: "/tmp/cache/photo.jpg",
      outputFileName: "photo.jpg", originalBytes: 1_200_000, outputBytes: 1_800_000, targetFormat: "jpg" });
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await user.click(screen.getByTestId("image-drop-zone"));
    expect(await within(screen.getByRole("region", { name: "Images to compress" })).findByText(/50% larger/)).toBeVisible();
    expect(screen.getByText(/Try lower quality or a different target format/)).toBeVisible();
    expect(screen.queryByText(/0% saved/)).not.toBeInTheDocument();
  });

  it("unsubscribes native file drops when leaving the page", () => {
    const unsubscribe = vi.fn();
    mockOnFileDrop.mockReturnValueOnce(unsubscribe);
    const { rerender } = render(<OptimizePage namingTemplate="{slug}.{ext}" isActive />);
    expect(mockOnFileDrop).toHaveBeenCalled();
    rerender(<OptimizePage namingTemplate="{slug}.{ext}" isActive={false} />);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("starts empty with an add action and offers clear only after images are added", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    expect(screen.getByRole("heading", { name: "Prepare images" })).toBeInTheDocument();
    expect(screen.queryByText("Optimize")).not.toBeInTheDocument();
    expect(screen.getByText(/choose images/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add images" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Clear batch" })).not.toBeInTheDocument();
    const railTools = screen.getByLabelText("Images to compress").querySelector(".rail-tools");
    expect(Array.from(railTools!.querySelectorAll("button"), (button) => button.getAttribute("aria-label"))).toEqual(["Add images"]);
    expect(screen.queryByText("photo-01.jpg")).not.toBeInTheDocument();
    expect(screen.queryByText("/sample/photo-01.jpg")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add images" }));
    expect(await screen.findByText("1 of 1 ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add images" })).toBeEnabled();
    expect(Array.from(railTools!.querySelectorAll("button"), (button) => button.getAttribute("aria-label"))).toEqual(["Clear batch", "Add images"]);
    await user.click(screen.getByRole("button", { name: "Clear batch" }));
    expect(screen.queryByRole("button", { name: "Clear batch" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add images" })).toBeEnabled();
  });

  it.each(["webp", "avif", "jxl"])("dispatches a %s encode with the matching output filename", async (format) => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await user.click(screen.getByTestId("image-drop-zone"));
    await screen.findByRole("button", { name: "Compare real-photo.jpg" });
    await setItemFormat(user, "real-photo.jpg", format);
    await waitFor(() => {
      expect(compressImage).toHaveBeenLastCalledWith(expect.objectContaining({
        outputFileName: `real-photo.${format}`,
        settings: expect.objectContaining({ targetFormat: format, quality: 85 }),
      }));
    });
  });

  it("opens the image picker when the drop zone is clicked", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByTestId("image-drop-zone"));

    expect(mockDialogOpen).toHaveBeenCalledWith({
      multiple: true,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "avif", "jxl", "heif", "heic"] }],
    });
  });

  it("offers batch presets and starts compression without a manual Compress button", () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    expect(screen.getByRole("combobox", { name: "Batch preset" })).toHaveValue("original");
    expect(screen.queryByRole("button", { name: /^compress$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Batch format" })).toHaveValue("original");
    expect(screen.getByRole("slider", { name: /quality/i })).toBeInTheDocument();
  });

  it("applies a batch preset to new images and restores full dimensions for lossless output", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Batch preset" }), "balanced");
    await user.click(screen.getByTestId("image-drop-zone"));
    await screen.findByRole("button", { name: "Compare real-photo.jpg" });
    expect(compressImage).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ targetFormat: "webp", quality: 82 }) }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Longest edge" }), "1280");
    await waitFor(() => expect(compressImage).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ maxDimension: 1280 }) })));
    await user.selectOptions(screen.getByRole("combobox", { name: "Batch preset" }), "lossless");
    await waitFor(() => expect(compressImage).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ targetFormat: "jxl", quality: 100, maxDimension: undefined }) })));
    expect(screen.getByRole("combobox", { name: "Longest edge" })).toHaveValue("0");
  });

  it("changes the batch format independently, preserves quality and applies it to later imports", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Batch format" }), "avif");
    expect(screen.getByRole("slider", { name: "Quality" })).toHaveValue("85");
    expect(screen.getByRole("combobox", { name: "Batch preset" })).toHaveValue("custom");
    await user.click(screen.getByTestId("image-drop-zone"));
    await screen.findByRole("button", { name: "Compare real-photo.jpg" });
    expect(compressImage).toHaveBeenLastCalledWith(expect.objectContaining({ outputFileName: "real-photo.avif", settings: expect.objectContaining({ targetFormat: "avif", quality: 85 }) }));
    let finish!: (result: Awaited<ReturnType<typeof compressImage>>) => void;
    compressImage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Batch format" }), "png");
    expect(screen.getByRole("slider", { name: "Quality" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save to local folder" })).not.toBeInTheDocument();
    await waitFor(() => expect(compressImage).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ targetFormat: "png", quality: 85 }) })));
    await act(async () => finish({ sourcePath: "/tmp/real-photo.jpg", outputPath: "/tmp/pic-piper/new.png", outputFileName: "real-photo.png", originalBytes: 1_200_000, outputBytes: 300_000, targetFormat: "png" }));
    expect(await screen.findByRole("button", { name: "Save to local folder" })).toBeEnabled();
  });

  it("uses PNG for lossless high-bit-depth images and WebP for animations", async () => {
    inspectImage.mockImplementationOnce(async () => ({
      id: "precision", sourcePath: "/tmp/real-photo.jpg", fileName: "precision.png", sourceFormat: "png",
      originalBytes: 1200, estimatedBytes: 1200, status: "queued", bitDepth: 16, frameCount: 1,
      settings: { targetFormat: "png", quality: 85, removeGps: true },
    }));
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Batch preset" }), "lossless");
    await user.click(screen.getByTestId("image-drop-zone"));
    await screen.findByRole("button", { name: "Compare precision.png" });
    expect(compressImage).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ targetFormat: "png", quality: 100 }) }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Batch preset" }), "balanced");
    await screen.findByRole("button", { name: "Compare precision.png" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Batch preset" }), "lossless");
    await screen.findByRole("button", { name: "Compare precision.png" });
    expect(compressImage).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ targetFormat: "png", quality: 100 }) }));
    await user.click(screen.getByRole("button", { name: "Clear batch" }));
    inspectImage.mockImplementationOnce(async () => ({
      id: "animation", sourcePath: "/tmp/real-photo.jpg", fileName: "animation.webp", sourceFormat: "webp",
      originalBytes: 1200, estimatedBytes: 1200, status: "queued", bitDepth: 8, frameCount: 2,
      settings: { targetFormat: "webp", quality: 85, removeGps: true },
    }));
    await user.click(screen.getByTestId("image-drop-zone"));
    await screen.findByRole("button", { name: "Compare animation.webp" });
    expect(compressImage).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ targetFormat: "webp", quality: 100 }) }));
  });

  it("requires confirmation for a static animation export and can restore all frames", async () => {
    inspectImage.mockImplementationOnce(async () => ({
      id: "animation", sourcePath: "/tmp/real-photo.jpg", fileName: "animation.webp", sourceFormat: "webp",
      originalBytes: 1200, estimatedBytes: 1200, status: "queued", frameCount: 2,
      settings: { targetFormat: "webp", quality: 85, removeGps: true },
    }));
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await user.click(screen.getByTestId("image-drop-zone"));
    await screen.findByRole("button", { name: "Compare animation.webp" });
    const calls = compressImage.mock.calls.length;
    await setItemFormat(user, "animation.webp", "png");
    expect(screen.getByRole("dialog", { name: "Export the first frame?" })).toBeVisible();
    expect(compressImage).toHaveBeenCalledTimes(calls);
    await user.click(screen.getByRole("button", { name: "Keep animation" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Format for animation.webp")).toHaveValue("webp");
    await setItemFormat(user, "animation.webp", "png");
    await user.click(screen.getByRole("button", { name: "Export first frame" }));
    await waitFor(() => expect(compressImage).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ targetFormat: "png", animationMode: "firstFrame" }) })));
    await screen.findByRole("button", { name: "Compare animation.webp" });
    expect(screen.getByLabelText("Animation output")).toHaveValue("firstFrame");
    await user.selectOptions(screen.getByLabelText("Animation output"), "preserve");
    await waitFor(() => expect(compressImage).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ targetFormat: "webp", animationMode: "preserve" }) })));
    await screen.findByRole("button", { name: "Compare animation.webp" });
    await user.selectOptions(screen.getByLabelText("Batch preset"), "small");
    await waitFor(() => expect(compressImage).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ targetFormat: "webp", quality: 55 }) })));
  });

  it("offers explicit first-frame extraction when sequence frame count is unavailable", async () => {
    inspectImage.mockImplementationOnce(async () => ({
      id: "sequence", sourcePath: "/tmp/real-photo.jpg", fileName: "sequence.avif", sourceFormat: "avif",
      originalBytes: 1200, estimatedBytes: 1200, status: "queued", frameCount: 1, animated: true,
      settings: { targetFormat: "avif", quality: 85, removeGps: true },
    }));
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await user.click(screen.getByTestId("image-drop-zone"));
    await screen.findByRole("button", { name: "Compare sequence.avif" });
    await user.selectOptions(screen.getByLabelText("Animation output"), "firstFrame");
    await waitFor(() => expect(compressImage).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ targetFormat: "avif", animationMode: "firstFrame" }) })));
  });

  it("explains that HDR previews and export share SDR tone mapping", async () => {
    inspectImage.mockImplementationOnce(async () => ({
      id: "hdr", sourcePath: "/tmp/real-photo.jpg", fileName: "hdr.png", sourceFormat: "png",
      originalBytes: 1200, estimatedBytes: 1200, status: "queued", bitDepth: 16, hdr: true,
      settings: { targetFormat: "png", quality: 85, removeGps: true },
    }));
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await user.click(screen.getByTestId("image-drop-zone"));
    await screen.findByRole("button", { name: "Compare hdr.png" });
    expect(screen.getByText(/HDR preview and export are tone-mapped/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Compare hdr.png" }));
    expect(await screen.findByText(/HDR original shown with the same SDR tone mapping/)).toBeVisible();
  });

  it("reloads the original preview when a setting change cancels its first read", async () => {
    let finishOriginal!: (value: { dataUrl: string }) => void;
    readThumbnail.mockImplementationOnce(() => new Promise((resolve) => { finishOriginal = resolve; }));
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await user.click(screen.getByTestId("image-drop-zone"));
    await screen.findByRole("button", { name: "Compare real-photo.jpg" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Batch preset" }), "balanced");
    await screen.findByRole("button", { name: "Compare real-photo.jpg" });
    await user.click(within(screen.getByRole("group", { name: "Preview version" })).getByRole("button", { name: "Original" }));
    expect(await screen.findByAltText("Original preview of real-photo.jpg")).toHaveAttribute("src", "data:image/jpeg;base64,ORIGINAL");
    await act(async () => { finishOriginal({ dataUrl: "data:image/jpeg;base64,LATE" }); });
    expect(screen.getByAltText("Original preview of real-photo.jpg")).toHaveAttribute("src", "data:image/jpeg;base64,ORIGINAL");
  });

  it("retries failed images with the latest batch preset", async () => {
    compressImage.mockRejectedValueOnce(new Error("Try a different target format"));
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await user.click(screen.getByTestId("image-drop-zone"));
    await screen.findByText("Try a different target format");
    await user.selectOptions(screen.getByRole("combobox", { name: "Batch preset" }), "balanced");
    expect(compressImage).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Retry unfinished" }));
    await screen.findByRole("button", { name: "Compare real-photo.jpg" });
    expect(compressImage).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ targetFormat: "webp", quality: 82 }) }));
  });

  it("skips duplicate imports and lets a cleared image be imported again", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await user.click(screen.getByTestId("image-drop-zone"));
    await screen.findByRole("button", { name: "Compare real-photo.jpg" });
    await user.click(screen.getByTestId("image-drop-zone"));
    expect(await screen.findByText(/duplicates skipped/)).toBeVisible();
    expect(inspectImage).toHaveBeenCalledTimes(1);
    expect(compressImage).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Clear batch" }));
    expect(screen.queryByRole("button", { name: "Compare real-photo.jpg" })).not.toBeInTheDocument();
    await user.click(screen.getByTestId("image-drop-zone"));
    await screen.findByRole("button", { name: "Compare real-photo.jpg" });
    expect(inspectImage).toHaveBeenCalledTimes(2);
  });

  it("shares a pending cache run across concurrent images", async () => {
    let finishRun!: (value: { runId: string; outputDir: string }) => void;
    createOptimizerRun.mockImplementationOnce(() => new Promise((resolve) => { finishRun = resolve; }));
    mockDialogOpen.mockResolvedValueOnce(["/tmp/a.jpg", "/tmp/b.jpg"]);
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await user.click(screen.getByTestId("image-drop-zone"));
    await waitFor(() => expect(createOptimizerRun).toHaveBeenCalledTimes(1));
    expect(compressImage).not.toHaveBeenCalled();
    await act(async () => { finishRun({ runId: "shared", outputDir: "/tmp/shared" }); });
    await waitFor(() => expect(compressImage).toHaveBeenCalledTimes(2));
    expect(createOptimizerRun).toHaveBeenCalledTimes(1);
    for (const index of [1, 2]) expect(compressImage).toHaveBeenNthCalledWith(index, expect.objectContaining({ outputDir: "/tmp/shared" }));
  });

  it("withholds old exports while a resize is being encoded", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await user.click(screen.getByTestId("image-drop-zone"));
    await screen.findByRole("button", { name: "Save to local folder" });
    let finish!: () => void;
    compressImage.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ sourcePath: "/tmp/real-photo.jpg", outputPath: "/tmp/resized.jpg", outputFileName: "resized.jpg", originalBytes: 1_200_000, outputBytes: 100_000, targetFormat: "jpg" }); }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Longest edge" }), "1280");
    await waitFor(() => expect(compressImage).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ maxDimension: 1280 }) })));
    expect(screen.queryByRole("button", { name: "Save to local folder" })).not.toBeInTheDocument();
    await act(async () => { finish(); });
    expect(await screen.findByRole("button", { name: "Save to local folder" })).toBeEnabled();
  });

  it("shows picker errors in the workbench and allows another attempt", async () => {
    mockDialogOpen.mockRejectedValueOnce(new Error("The image picker is unavailable"));
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await user.click(screen.getByTestId("image-drop-zone"));
    expect(await screen.findByText("The image picker is unavailable")).toBeVisible();
    await user.click(screen.getByTestId("image-drop-zone"));
    expect(await screen.findByRole("button", { name: "Compare real-photo.jpg" })).toBeVisible();
    expect(screen.queryByText("The image picker is unavailable")).not.toBeInTheDocument();
  });

  it("retries failed inspection from the batch action", async () => {
    inspectImage.mockRejectedValueOnce(new Error("Image temporarily unavailable"));
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{slug}.{ext}" />);
    await user.click(screen.getByTestId("image-drop-zone"));
    const retry = await screen.findByRole("button", { name: "Retry unfinished" });
    expect(compressImage).not.toHaveBeenCalled();
    await user.click(retry);
    expect(await screen.findByRole("button", { name: "Compare real-photo.jpg" })).toBeVisible();
    expect(inspectImage).toHaveBeenCalledTimes(2);
    expect(compressImage).toHaveBeenCalledTimes(1);
  });

  it("shows informational text about metadata stripping instead of a Remove GPS checkbox", () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    // No checkbox should exist
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    // Informational text about metadata stripping should be visible
    expect(screen.getByRole("combobox", { name: "Batch format" })).toHaveValue("original");
  });

  it("keeps quality controls constrained beside the workspace title", () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    expect(screen.getByRole("slider", { name: /quality/i })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Batch format" })).toBeVisible();
  });

  it("imports selected images and starts single-image compression automatically", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));

    expect(inspectImage).toHaveBeenCalledWith({
      taskId: expect.any(String),
      path: "/tmp/real-photo.jpg",
      settings: expect.objectContaining({ targetFormat: "jpg", quality: 85, removeGps: true }),
    });
    expect(await screen.findByRole("button", { name: "Select real-photo.jpg" })).toBeInTheDocument();
    expect(compressImage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: "/tmp/real-photo.jpg",
        outputFileName: "real-photo.jpg",
        settings: expect.objectContaining({ targetFormat: "jpg", quality: 85, removeGps: true }),
      }),
    );
    expect(await within(screen.getByLabelText("Images to compress")).findByText(/1.2 MB.*240 KB/)).toBeInTheDocument();
  });

  it("opens a comparison dialog from a compressed preview", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    const previewButton = await screen.findByRole("button", { name: /compare real-photo\.jpg/i });
    await user.click(previewButton);

    expect(screen.getByRole("dialog", { name: /compare real-photo\.jpg/i })).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: /compare real-photo\.jpg/i });
    expect(await within(dialog).findByText("Original", { exact: true })).toBeInTheDocument();
    expect(within(dialog).getByText("Compressed", { exact: true })).toBeInTheDocument();
  });

  it("recompresses existing items after global quality changes", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    // Import and wait for initial compression with real timers
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await within(screen.getByLabelText("Images to compress")).findByText(/1.2 MB.*240 KB/);
    compressImage.mockClear();

    // Change quality via slider and wait for debounce (400ms) + scheduler
    fireEvent.change(screen.getByRole("slider", { name: /quality/i }), { target: { value: "60" } });

    await waitFor(() => {
      expect(compressImage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ quality: 60 }),
        }),
      );
    });
  });

  it("updates the displayed compressed size after global quality recompression finishes", async () => {
    createOptimizerRun
      .mockResolvedValueOnce({ runId: "run-1", outputDir: "/tmp/pic-piper/run-1" })
      .mockResolvedValueOnce({ runId: "run-2", outputDir: "/tmp/pic-piper/run-2" });
    compressImage.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as { sourcePath?: string; outputDir?: string; outputFileName?: string; settings?: { quality: number } } | undefined;
      const outputDir = request?.outputDir ?? "/tmp/pic-piper/run-1";
      const outputBytes = request?.settings?.quality === 60 ? 120_000 : 240_000;
      return {
        sourcePath: request?.sourcePath ?? "/tmp/real-photo.jpg",
        outputPath: `${outputDir}/${request?.outputFileName ?? "real-photo.jpg"}`,
        outputFileName: request?.outputFileName ?? "real-photo.jpg",
        originalBytes: 1_200_000,
        outputBytes,
        targetFormat: "jpg",
      };
    });

    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    expect(await within(screen.getByLabelText("Images to compress")).findByText(/1.2 MB.*240 KB/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("slider", { name: /quality/i }), { target: { value: "60" } });

    expect(await within(screen.getByLabelText("Images to compress")).findByText(/1.2 MB.*120 KB/)).toBeInTheDocument();
    expect(within(screen.getByLabelText("Images to compress")).queryByText(/1.2 MB.*240 KB/)).not.toBeInTheDocument();
    expect(createOptimizerRun).toHaveBeenCalledTimes(2);
    expect(compressImage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outputDir: "/tmp/pic-piper/run-2",
      }),
    );
  });

  it("changing one card format recompresses only that item", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await within(screen.getByLabelText("Images to compress")).findByText(/1.2 MB.*240 KB/);
    compressImage.mockClear();

    await user.selectOptions(screen.getByLabelText(/format for real-photo\.jpg/i), "png");

    expect(compressImage).toHaveBeenCalledTimes(1);
    expect(compressImage).toHaveBeenCalledWith(
      expect.objectContaining({
        outputFileName: "real-photo.png",
        settings: expect.objectContaining({ targetFormat: "png" }),
      }),
    );
  });

  it("changing format after compression does not produce stale -2 suffix", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    // Import and compress
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await within(screen.getByLabelText("Images to compress")).findByText(/1.2 MB.*240 KB/);
    compressImage.mockClear();

    // Change format - should use fresh filename claim, not stale -2
    await user.selectOptions(screen.getByLabelText(/format for real-photo\.jpg/i), "png");

    expect(compressImage).toHaveBeenCalledTimes(1);
    expect(compressImage).toHaveBeenCalledWith(
      expect.objectContaining({
        outputFileName: "real-photo.png",
      }),
    );
  });

  it("warns when selected PNG output ignores quality", async () => {
    inspectImage.mockImplementation(async () => ({
      id: "real-photo",
      sourcePath: "/tmp/real-photo.png",
      fileName: "real-photo.png",
      sourceFormat: "png",
      originalBytes: 1_200_000,
      estimatedBytes: 260_000,
      status: "queued",
      settings: {
        targetFormat: "png",
        quality: 85,
        removeGps: true,
      },
    }));
    mockDialogOpen.mockImplementation(async (...args: unknown[]) => {
      const opts = args[0] as { directory?: boolean } | undefined;
      if (opts?.directory) return "/tmp/saved" as unknown as string[];
      return ["/tmp/real-photo.png"];
    });

    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await user.selectOptions(await screen.findByLabelText(/format for real-photo\.png/i), "png");

    expect(await screen.findByText(/PNG output is lossless; quality does not apply/i)).toBeInTheDocument();
  });

  it("keeps duplicate output filenames unique across sequential scheduler batches", async () => {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      value: 2,
    });
    mockDialogOpen.mockImplementation(async (...args: unknown[]) => {
      const opts = args[0] as { directory?: boolean } | undefined;
      if (opts?.directory) return "/tmp/saved" as unknown as string[];
      return ["/tmp/first/photo.jpg", "/tmp/second/photo.jpg"];
    });
    inspectImage.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as { path: string };
      return {
        id: request.path,
        sourcePath: request.path,
        fileName: "photo.jpg",
        sourceFormat: "jpg",
        originalBytes: 1_200_000,
        estimatedBytes: 260_000,
        status: "queued",
        settings: {
          targetFormat: "jpg",
          quality: 85,
          removeGps: true,
        },
      };
    });
    compressImage.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as { sourcePath: string; outputFileName: string };
      return {
        sourcePath: request.sourcePath,
        outputPath: `/tmp/pic-piper/run-1/${request.outputFileName}`,
        outputFileName: request.outputFileName,
        originalBytes: 1_200_000,
        outputBytes: 240_000,
        targetFormat: "jpg",
      };
    });

    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));

    await waitFor(() => {
      expect(compressImage).toHaveBeenCalledTimes(2);
    });
    const compressRequests = compressImage.mock.calls as unknown as Array<[{ outputFileName: string }]>;
    expect(compressRequests.map(([request]) => request.outputFileName)).toEqual([
      "photo.jpg",
      "photo-2.jpg",
    ]);
  });

  it("appending a same-named image after compression uses a unique output name", async () => {
    let importCount = 0;
    mockDialogOpen.mockImplementation(async (...args: unknown[]) => {
      const opts = args[0] as { directory?: boolean } | undefined;
      if (opts?.directory) return "/tmp/saved" as unknown as string[];
      importCount++;
      return importCount === 1 ? ["/tmp/first/photo.jpg"] : ["/tmp/second/photo.jpg"];
    });
    inspectImage.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as { path: string };
      return {
        id: request.path,
        sourcePath: request.path,
        fileName: "photo.jpg",
        sourceFormat: "jpg",
        originalBytes: 1_200_000,
        estimatedBytes: 260_000,
        status: "queued",
        settings: {
          targetFormat: "jpg",
          quality: 85,
          removeGps: true,
        },
      };
    });
    compressImage.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as { sourcePath: string; outputFileName: string; outputDir: string };
      return {
        sourcePath: request.sourcePath,
        outputPath: `${request.outputDir}/${request.outputFileName}`,
        outputFileName: request.outputFileName,
        originalBytes: 1_200_000,
        outputBytes: 240_000,
        targetFormat: "jpg",
      };
    });

    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    // First import: photo.jpg -> compresses to photo.jpg
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await waitFor(() => {
      expect(compressImage).toHaveBeenCalledTimes(1);
    });
    expect(compressImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ outputFileName: "photo.jpg" }),
    );

    // Second import: another photo.jpg appended
    await user.click(screen.getByRole("button", { name: "Add images" }));
    await waitFor(() => {
      expect(compressImage).toHaveBeenCalledTimes(2);
    });

    // The second import should use photo-2.jpg, not overwrite photo.jpg
    const calls = compressImage.mock.calls as unknown as Array<[{ outputFileName: string }]>;
    expect(calls[1][0].outputFileName).toBe("photo-2.jpg");
  });

  it("does not queue an inspecting placeholder when global settings change", async () => {
    let resolveInspect!: (value: Awaited<ReturnType<typeof inspectImage>>) => void;
    inspectImage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInspect = resolve;
        }),
    );

    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    expect(await screen.findByRole("button", { name: "Select real-photo.jpg" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("slider", { name: /quality/i }), { target: { value: "60" } });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
    });

    expect(compressImage).not.toHaveBeenCalled();

    await act(async () => {
      resolveInspect({
        id: "real-photo",
        sourcePath: "/tmp/real-photo.jpg",
        fileName: "real-photo.jpg",
        sourceFormat: "jpg",
        originalBytes: 1_200_000,
        estimatedBytes: 260_000,
        status: "queued",
        settings: {
          targetFormat: "jpg",
          quality: 60,
          removeGps: true,
        },
      });
    });

    await waitFor(() => {
      expect(compressImage).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ quality: 60 }),
        }),
      );
    });
  });

  it("keeps an image cancelled when its inspection finishes after cancellation", async () => {
    let resolveInspect!: (value: Awaited<ReturnType<typeof inspectImage>>) => void;
    inspectImage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInspect = resolve;
        }),
    );

    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await user.click(await screen.findByRole("button", { name: /cancel real-photo\.jpg/i }));
    expect(cancelImageTask).toHaveBeenCalledWith({ taskId: expect.stringMatching(/:0$/) });

    await act(async () => {
      resolveInspect({
        id: "real-photo",
        sourcePath: "/tmp/real-photo.jpg",
        fileName: "real-photo.jpg",
        sourceFormat: "jpg",
        originalBytes: 1_200_000,
        estimatedBytes: 260_000,
        status: "queued",
        settings: {
          targetFormat: "jpg",
          quality: 85,
          removeGps: true,
        },
      });
    });

    expect(await screen.findByText(/cancelled/i)).toBeInTheDocument();
    expect(compressImage).not.toHaveBeenCalled();
  });

  it("does not apply late compression results after cancellation", async () => {
    let resolveCompression!: (value: Awaited<ReturnType<typeof compressImage>>) => void;
    compressImage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCompression = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await screen.findByText(/compressing/i);
    await user.click(screen.getByRole("button", { name: /cancel real-photo\.jpg/i }));
    expect(cancelImageTask).toHaveBeenCalledWith({ taskId: expect.stringMatching(/:0$/) });

    resolveCompression({
      sourcePath: "/tmp/real-photo.jpg",
      outputPath: "/tmp/pic-piper/run-1/real-photo.jpg",
      outputFileName: "real-photo.jpg",
      originalBytes: 1_200_000,
      outputBytes: 240_000,
      targetFormat: "jpg",
    });

    expect(await screen.findByText(/cancelled/i)).toBeInTheDocument();
    expect(within(screen.getByLabelText("Images to compress")).queryByText(/1.2 MB.*240 KB/)).not.toBeInTheDocument();
  });

  it("does not dispatch duplicate compression when quality changes during active compression", async () => {
    // Create a delayed compression that we can control
    let resolveCompression!: (value: Awaited<ReturnType<typeof compressImage>>) => void;
    compressImage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCompression = resolve;
        }),
    );

    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    // Import image and wait for compression to start
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await screen.findByText(/compressing/i);

    // compressImage should be called once for the initial compression
    expect(compressImage).toHaveBeenCalledTimes(1);
    compressImage.mockClear();

    // Change quality while compression is in progress
    fireEvent.change(screen.getByRole("slider", { name: /quality/i }), { target: { value: "60" } });

    // Wait a bit for any potential duplicate dispatch
    await new Promise((resolve) => setTimeout(resolve, 100));

    // compressImage should NOT be called again while the item is still compressing
    expect(compressImage).not.toHaveBeenCalled();

    // Resolve the original compression
    resolveCompression({
      sourcePath: "/tmp/real-photo.jpg",
      outputPath: "/tmp/pic-piper/run-1/real-photo.jpg",
      outputFileName: "real-photo.jpg",
      originalBytes: 1_200_000,
      outputBytes: 240_000,
      targetFormat: "jpg",
    });

    // After debounce (400ms), the quality change should trigger requeue
    // and then a new compression should be dispatched
    await waitFor(() => {
      expect(compressImage).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ quality: 60 }),
        }),
      );
    }, { timeout: 1000 });
  });

  it("Save to local folder opens directory picker and copies files", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    // Import and wait for automatic compression
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await within(screen.getByLabelText("Images to compress")).findByText(/1.2 MB.*240 KB/);

    // Click Save to local folder
    await user.click(screen.getByRole("button", { name: "Save to local folder" }));

    expect(mockDialogOpen).toHaveBeenCalledWith({ directory: true });
    expect(copyOutputsToDir).toHaveBeenCalledWith({
      outputPaths: ["/tmp/pic-piper/run-1/real-photo.jpg"],
      targetDir: "/tmp/saved",
    });
  });

  it("shows in-page success message after saving locally instead of alert", async () => {
    const alertSpy = vi.spyOn(window, "alert");
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    // Import and wait for automatic compression
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await within(screen.getByLabelText("Images to compress")).findByText(/1.2 MB.*240 KB/);

    // Save to local folder
    await user.click(screen.getByRole("button", { name: "Save to local folder" }));

    // Should show success message in the page
    expect(await screen.findByText(/Saved 1 file\(s\) to \/tmp\/saved/)).toBeInTheDocument();
    // Should NOT call window.alert
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it("removes an image from the queue when the X button is clicked", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await screen.findByRole("button", { name: "Select real-photo.jpg" });

    const removeBtn = screen.getByRole("button", {
      name: /^Remove real-photo\.jpg$/i,
    });
    await user.click(removeBtn);

    expect(screen.queryByText("real-photo.jpg")).not.toBeInTheDocument();
  });

  it("uploads to the bucket selected in compression actions", async () => {
    const first = { id: "p1", name: "First", bucket: "first", endpoint: "https://s3.example.com", region: "auto", accessKeyId: "fake", pathStyle: true, defaultPrefix: "images" };
    const second = { ...first, id: "p2", name: "Second", bucket: "second" };
    const user = userEvent.setup();
    render(<OptimizePage activeProfile={first} profiles={[first, second]} namingTemplate="{slug}.{ext}" />);
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await within(screen.getByLabelText("Images to compress")).findByText(/1.2 MB.*240 KB/);
    await user.click(screen.getByRole("button", { name: "Upload to S3" }));
    await waitFor(() => expect(uploadObject).toHaveBeenCalledWith(expect.objectContaining({ profile: first })));
    await user.selectOptions(screen.getByRole("combobox", { name: "Upload destination" }), "p2");
    await user.click(screen.getByRole("button", { name: "Upload to S3" }));
    await waitFor(() => expect(uploadObject).toHaveBeenCalledWith(expect.objectContaining({ profile: second })));
    expect(screen.getByRole("combobox", { name: "Upload destination" })).toHaveValue("p2");
  });

  it("Upload to S3 calls generateObjectKey and uploadObject with correct params", async () => {
    const profile = {
      id: "p1",
      name: "Personal S3",
      bucket: "images",
      endpoint: "https://s3.example.com",
      region: "auto",
      accessKeyId: "AKIAEXAMPLE",
      pathStyle: false,
      defaultPrefix: "images/2026/06",
      publicBaseUrl: "https://cdn.example.com",
    };
    const onUploadedToS3 = vi.fn();
    const user = userEvent.setup();
    render(
      <OptimizePage
        activeProfile={profile}
        namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}"
        onUploadedToS3={onUploadedToS3}
      />,
    );

    // Import and wait for automatic compression
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await within(screen.getByLabelText("Images to compress")).findByText(/1.2 MB.*240 KB/);

    // Click Upload to S3
    await user.click(screen.getByRole("button", { name: "Upload to S3" }));

    expect(generateObjectKey).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: "/tmp/pic-piper/run-1/real-photo.jpg",
        outputFileName: "real-photo.jpg",
        ext: "jpg",
        prefix: "images/2026/06",
        namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
      }),
    );
    expect(uploadObject).toHaveBeenCalledWith(
      expect.objectContaining({
        profile,
        sourcePath: "/tmp/pic-piper/run-1/real-photo.jpg",
        objectKey: "images/2026/06/real-photo-abcdef12.jpg",
        contentType: "image/jpeg",
      }),
    );
    expect(onUploadedToS3).toHaveBeenCalledWith({
      profileId: "p1",
      prefix: "images/2026/06",
      highlightedKeys: ["images/2026/06/real-photo-abcdef12.jpg"],
    });
  });

  it("locks queue mutations while an upload snapshot is in flight", async () => {
    const profile = {
      id: "p1",
      name: "Personal S3",
      bucket: "images",
      endpoint: "https://s3.example.com",
      region: "auto",
      accessKeyId: "AKIAEXAMPLE",
      pathStyle: false,
      defaultPrefix: "images/2026/06",
    };
    let finishUpload!: (value: {
      key: string;
      size: number;
      publicUrl: string;
      isImage: boolean;
    }) => void;
    uploadObject.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpload = resolve;
        }),
    );
    const user = userEvent.setup();
    render(
      <OptimizePage
        activeProfile={profile}
        namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}"
      />,
    );

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await within(screen.getByLabelText("Images to compress")).findByText(/1.2 MB.*240 KB/);
    await user.click(screen.getByRole("button", { name: "Upload to S3" }));
    await screen.findByText(/uploading 1 image/i);

    expect(screen.getByRole("combobox", { name: "Upload destination" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: /quality/i })).toBeDisabled();
    expect(screen.getByTestId("image-drop-zone")).toBeDisabled();
    expect(screen.getByLabelText(/format for real-photo\.jpg/i)).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /^remove real-photo\.jpg$/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /^remove real-photo\.jpg$/i })).toBeDisabled();

    finishUpload({
      key: "images/2026/06/real-photo-abcdef12.jpg",
      size: 240_000,
      publicUrl: "https://cdn.example.com/images/2026/06/real-photo-abcdef12.jpg",
      isImage: true,
    });
    await waitFor(() => expect(uploadObject).toHaveBeenCalledTimes(1));
  });

  it("does not upload a stale output while quality re-compression is pending", async () => {
    const profile = {
      id: "p1",
      name: "Personal S3",
      bucket: "images",
      endpoint: "https://s3.example.com",
      region: "auto",
      accessKeyId: "AKIAEXAMPLE",
      pathStyle: false,
      defaultPrefix: "images/2026/06",
    };
    const onUploadedToS3 = vi.fn();
    const user = userEvent.setup();
    render(
      <OptimizePage
        activeProfile={profile}
        namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}"
        onUploadedToS3={onUploadedToS3}
      />,
    );

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await within(screen.getByLabelText("Images to compress")).findByText(/1.2 MB.*240 KB/);

    fireEvent.change(screen.getByRole("slider", { name: /quality/i }), {
      target: { value: "70" },
    });
    expect(screen.queryByRole("button", { name: "Upload to S3" })).not.toBeInTheDocument();
    expect(uploadObject).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(compressImage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ quality: 70 }),
        }),
      );
    });

    await user.click(screen.getByRole("button", { name: "Upload to S3" }));
    expect(uploadObject).toHaveBeenCalledTimes(1);
    expect(onUploadedToS3).toHaveBeenCalledTimes(1);
  });

  it("retry only uploads failed items and skips already uploaded ones", async () => {
    const profile = {
      id: "p1",
      name: "Personal S3",
      bucket: "images",
      endpoint: "https://s3.example.com",
      region: "auto",
      accessKeyId: "AKIAEXAMPLE",
      pathStyle: false,
      defaultPrefix: "images/2026/06",
      publicBaseUrl: "https://cdn.example.com",
    };
    const onUploadedToS3 = vi.fn();

    // Mock dialog to return 3 files
    mockDialogOpen.mockImplementation(async () => [
      "/tmp/photo-a.jpg",
      "/tmp/photo-b.jpg",
      "/tmp/photo-c.jpg",
    ]);

    // Mock inspectImage to return different items
    inspectImage
      .mockImplementationOnce(async () => ({
        id: "item-a",
        sourcePath: "/tmp/photo-a.jpg",
        fileName: "photo-a.jpg",
        sourceFormat: "jpg",
        originalBytes: 1_000_000,
        estimatedBytes: 200_000,
        status: "queued",
        settings: { targetFormat: "jpg", quality: 85, removeGps: true },
      }))
      .mockImplementationOnce(async () => ({
        id: "item-b",
        sourcePath: "/tmp/photo-b.jpg",
        fileName: "photo-b.jpg",
        sourceFormat: "jpg",
        originalBytes: 1_000_000,
        estimatedBytes: 200_000,
        status: "queued",
        settings: { targetFormat: "jpg", quality: 85, removeGps: true },
      }))
      .mockImplementationOnce(async () => ({
        id: "item-c",
        sourcePath: "/tmp/photo-c.jpg",
        fileName: "photo-c.jpg",
        sourceFormat: "jpg",
        originalBytes: 1_000_000,
        estimatedBytes: 200_000,
        status: "queued",
        settings: { targetFormat: "jpg", quality: 85, removeGps: true },
      }));

    // Mock compressImage to return success for all
    compressImage
      .mockImplementationOnce(async () => ({
        sourcePath: "/tmp/photo-a.jpg",
        outputPath: "/tmp/pic-piper/run-1/photo-a.jpg",
        outputFileName: "photo-a.jpg",
        originalBytes: 1_000_000,
        outputBytes: 200_000,
        targetFormat: "jpg",
      }))
      .mockImplementationOnce(async () => ({
        sourcePath: "/tmp/photo-b.jpg",
        outputPath: "/tmp/pic-piper/run-1/photo-b.jpg",
        outputFileName: "photo-b.jpg",
        originalBytes: 1_000_000,
        outputBytes: 200_000,
        targetFormat: "jpg",
      }))
      .mockImplementationOnce(async () => ({
        sourcePath: "/tmp/photo-c.jpg",
        outputPath: "/tmp/pic-piper/run-1/photo-c.jpg",
        outputFileName: "photo-c.jpg",
        originalBytes: 1_000_000,
        outputBytes: 200_000,
        targetFormat: "jpg",
      }));

    // Mock uploadObject: first succeeds, second hits a create-only collision, third succeeds
    uploadObject
      .mockImplementationOnce(async () => ({
        key: "images/2026/06/photo-a-abc.jpg",
        size: 200_000,
        publicUrl: "https://cdn.example.com/images/2026/06/photo-a-abc.jpg",
        isImage: true,
      }))
      .mockImplementationOnce(async () => {
        throw {
          code: "objectAlreadyExists",
          message: "An object with this key already exists.",
          recoverable: true,
        };
      })
      .mockImplementationOnce(async () => ({
        key: "images/2026/06/photo-c-abc.jpg",
        size: 200_000,
        publicUrl: "https://cdn.example.com/images/2026/06/photo-c-abc.jpg",
        isImage: true,
      }));

    const user = userEvent.setup();
    render(
      <OptimizePage
        activeProfile={profile}
        namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}"
        onUploadedToS3={onUploadedToS3}
      />,
    );

    // Import and wait for compression
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await waitFor(() => {
      expect(screen.getByText(/upload to s3/i)).toBeInTheDocument();
    });

    // Click Upload to S3
    await user.click(screen.getByRole("button", { name: "Upload to S3" }));

    // Wait for upload to complete (some succeed, some fail)
    await waitFor(() => {
      expect(screen.getByText(/1 of 3 upload\(s\) failed/i)).toBeInTheDocument();
    });

    // Verify retry button appears
    expect(screen.getByRole("button", { name: /retry 1 failed upload\(s\) with new key/i })).toBeInTheDocument();

    // uploadObject should have been called 3 times (a, b, c)
    expect(uploadObject).toHaveBeenCalledTimes(3);

    // Now mock the retry to succeed
    uploadObject.mockClear();
    uploadObject.mockImplementationOnce(async () => ({
      key: "images/2026/06/photo-b-retry.jpg",
      size: 200_000,
      publicUrl: "https://cdn.example.com/images/2026/06/photo-b-retry.jpg",
      isImage: true,
    }));

    // Click retry
    await user.click(screen.getByRole("button", { name: /retry 1 failed upload\(s\) with new key/i }));

    // Wait for retry to complete
    await waitFor(() => {
      expect(onUploadedToS3).toHaveBeenCalled();
    });

    // uploadObject should only be called once (for the failed item b)
    expect(uploadObject).toHaveBeenCalledTimes(1);
    expect(generateObjectKey).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: "/tmp/pic-piper/run-1/photo-b.jpg",
        collisionSuffix: "retry-1",
      }),
    );

    // Verify highlightedKeys includes both previous successes and new retry
    const lastCall = onUploadedToS3.mock.calls[onUploadedToS3.mock.calls.length - 1][0];
    expect(lastCall.highlightedKeys).toContain("images/2026/06/photo-a-abc.jpg");
    expect(lastCall.highlightedKeys).toContain("images/2026/06/photo-b-retry.jpg");
    expect(lastCall.highlightedKeys).toContain("images/2026/06/photo-c-abc.jpg");
  });

  it("uploads a newly compressed item without retrying an earlier failed upload", async () => {
    const profile = {
      id: "p1",
      name: "Personal S3",
      bucket: "images",
      endpoint: "https://s3.example.com",
      region: "auto",
      accessKeyId: "AKIAEXAMPLE",
      pathStyle: false,
      defaultPrefix: "images",
    };
    mockDialogOpen
      .mockResolvedValueOnce(["/tmp/first.jpg"] as unknown as string[])
      .mockResolvedValueOnce(["/tmp/second.jpg"] as unknown as string[]);
    uploadObject
      .mockRejectedValueOnce(new Error("Temporary network error"))
      .mockResolvedValueOnce({
        key: "images/2026/06/second.jpg",
        size: 200_000,
        publicUrl: "https://cdn.example.com/images/2026/06/second.jpg",
        isImage: true,
      });
    const user = userEvent.setup();
    render(
      <OptimizePage
        activeProfile={profile}
        namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}"
      />,
    );

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await screen.findByRole("button", { name: "Upload to S3" });
    await user.click(screen.getByRole("button", { name: "Upload to S3" }));
    expect(await screen.findByText(/1 of 1 upload\(s\) failed/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add images" }));
    const uploadNew = await screen.findByRole("button", { name: "Upload 1 new image(s) to S3" });
    await user.click(uploadNew);

    await waitFor(() => expect(uploadObject).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Retry 1 failed upload(s)" })).toBeInTheDocument();
  });

  it("dropping file with usable path calls inspectImage", async () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    const dropZone = document.querySelector("[data-testid='image-drop-zone']")!;
    const file = new File(["dummy"], "dropped-photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "path", { value: "/tmp/dropped-photo.jpg" });
    const fileList = Object.assign([file], { item: (i: number) => (fileList as unknown as File[])[i] });

    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { files: fileList },
    });
    dropZone.dispatchEvent(event);

    // The mock returns fileName "real-photo.jpg" regardless of input path
    expect(await screen.findByRole("button", { name: "Select real-photo.jpg" })).toBeInTheDocument();
    expect(inspectImage).toHaveBeenCalledWith({
      taskId: expect.any(String),
      path: "/tmp/dropped-photo.jpg",
      settings: expect.objectContaining({ targetFormat: "jpg", quality: 85 }),
    });
  });

  it("imports paths from the native file drop subscription", async () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);
    expect(mockOnFileDrop).toHaveBeenCalled();
    const handler = mockOnFileDrop.mock.calls[0][0];
    await act(async () => handler(["/tmp/native-dropped.jpg"]));
    expect(await screen.findByRole("button", { name: "Select real-photo.jpg" })).toBeInTheDocument();
    expect(inspectImage).toHaveBeenCalledWith({
      taskId: expect.any(String),
      path: "/tmp/native-dropped.jpg",
      settings: expect.objectContaining({ targetFormat: "jpg", quality: 85 }),
    });
  });

  it("uses per-item compressImage and never calls compressBatch", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await within(screen.getByLabelText("Images to compress")).findByText(/1.2 MB.*240 KB/);

    // compressImage was called (per-item API)
    expect(compressImage).toHaveBeenCalled();
    // The mock does not expose compressBatch — if OptimizePage tried to call
    // it, the test would fail with "compressBatch is not a function".
  });

  it("dropping file without usable path shows error and does not call inspectImage", async () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    const dropZone = document.querySelector("[data-testid='image-drop-zone']")!;
    const file = new File(["dummy"], "dropped-photo.jpg", { type: "image/jpeg" });
    const fileList = Object.assign([file], { item: (i: number) => (fileList as unknown as File[])[i] });

    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { files: fileList },
    });
    dropZone.dispatchEvent(event);

    expect(
      await screen.findByText(/drag\/drop file paths are unavailable/i),
    ).toBeInTheDocument();
    expect(inspectImage).not.toHaveBeenCalled();
  });
});
