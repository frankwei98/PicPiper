import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OptimizePage } from "./OptimizePage";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { createOptimizerRun, inspectImage, compressImage, copyOutputsToDir, readThumbnail, mockDialogOpen, mockOnDragDropEvent, uploadObject, generateObjectKey } = vi.hoisted(() => {
  const mockDialogOpen = vi.fn(async (..._args: unknown[]) => ["/tmp/real-photo.jpg"]);
  return {
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
    mockOnDragDropEvent: vi.fn(async () => vi.fn()),
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

vi.mock("@tauri-apps/plugin-dialog", async () => ({
  open: mockDialogOpen,
}));

vi.mock("@tauri-apps/api/webview", async () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: mockOnDragDropEvent,
  }),
}));

vi.mock("../../api/tauri", async () => ({
  tauriApi: {
    createOptimizerRun,
    inspectImage,
    compressImage,
    copyOutputsToDir,
    readThumbnail,
  },
  uploadApi: {
    uploadObject,
  },
  namingApi: {
    generateObjectKey,
  },
}));

describe("OptimizePage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    // Reset dialog mock to default behavior
    mockDialogOpen.mockImplementation(async (...args: unknown[]) => {
      const opts = args[0] as { directory?: boolean } | undefined;
      if (opts?.directory) return "/tmp/saved" as unknown as string[];
      return ["/tmp/real-photo.jpg"];
    });
  });

  it("starts empty and asks the user to choose images", () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    expect(screen.getByText(/choose images/i)).toBeInTheDocument();
    expect(screen.queryByText("photo-01.jpg")).not.toBeInTheDocument();
    expect(screen.queryByText("/sample/photo-01.jpg")).not.toBeInTheDocument();
  });

  it("does not render preset controls or a manual Compress button", () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    expect(screen.queryByLabelText(/preset/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^compress$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/metadata.*removed during compression/i)).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: /quality/i })).toBeInTheDocument();
  });

  it("shows informational text about metadata stripping instead of a Remove GPS checkbox", () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    // No checkbox should exist
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    // Informational text about metadata stripping should be visible
    expect(screen.getByText(/metadata.*removed during compression/i)).toBeInTheDocument();
  });

  it("imports selected images and starts single-image compression automatically", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));

    expect(inspectImage).toHaveBeenCalledWith({
      path: "/tmp/real-photo.jpg",
      settings: expect.objectContaining({ targetFormat: "webp", quality: 85, removeGps: true }),
    });
    expect(await screen.findByText("real-photo.jpg")).toBeInTheDocument();
    expect(compressImage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: "/tmp/real-photo.jpg",
        outputFileName: "real-photo.jpg",
        settings: expect.objectContaining({ targetFormat: "jpg", quality: 85, removeGps: true }),
      }),
    );
    expect(await screen.findByText(/1.2 MB.*240 KB/)).toBeInTheDocument();
  });

  it("opens a comparison dialog from a compressed preview", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    const previewButton = await screen.findByRole("button", { name: /compare real-photo\.jpg/i });
    await user.click(previewButton);

    expect(screen.getByRole("dialog", { name: /compare real-photo\.jpg/i })).toBeInTheDocument();
    expect(screen.getByText(/original/i)).toBeInTheDocument();
    expect(screen.getByText(/compressed/i)).toBeInTheDocument();
  });

  it("recompresses existing items after global quality changes", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    // Import and wait for initial compression with real timers
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await screen.findByText(/1.2 MB.*240 KB/);
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

  it("changing one card format recompresses only that item", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await screen.findByText(/1.2 MB.*240 KB/);
    compressImage.mockClear();

    await user.selectOptions(screen.getByLabelText(/format for real-photo\.jpg/i), "webp");

    expect(compressImage).toHaveBeenCalledTimes(1);
    expect(compressImage).toHaveBeenCalledWith(
      expect.objectContaining({
        outputFileName: "real-photo.webp",
        settings: expect.objectContaining({ targetFormat: "webp" }),
      }),
    );
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

    resolveCompression({
      sourcePath: "/tmp/real-photo.jpg",
      outputPath: "/tmp/pic-piper/run-1/real-photo.jpg",
      outputFileName: "real-photo.jpg",
      originalBytes: 1_200_000,
      outputBytes: 240_000,
      targetFormat: "jpg",
    });

    expect(await screen.findByText(/cancelled/i)).toBeInTheDocument();
    expect(screen.queryByText(/1.2 MB.*240 KB/)).not.toBeInTheDocument();
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
    await screen.findByText(/1.2 MB.*240 KB/);

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
    await screen.findByText(/1.2 MB.*240 KB/);

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
    await screen.findByText("real-photo.jpg");

    const removeBtn = screen.getByRole("button", {
      name: /Remove real-photo\.jpg from queue/i,
    });
    await user.click(removeBtn);

    expect(screen.queryByText("real-photo.jpg")).not.toBeInTheDocument();
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
      insecureSecretFallback: false,
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
    await screen.findByText(/1.2 MB.*240 KB/);

    // Click Upload to S3
    await user.click(screen.getByRole("button", { name: "Upload to S3" }));

    expect(generateObjectKey).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: "/tmp/pic-piper/run-1/real-photo.jpg",
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
      profile,
      prefix: "images/2026/06",
      highlightedKeys: ["images/2026/06/real-photo-abcdef12.jpg"],
    });
  });

  it("dropping file with usable path calls inspectImage", async () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    const dropZone = document.querySelector("[data-testid='drop-zone']")!;
    const file = new File(["dummy"], "dropped-photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "path", { value: "/tmp/dropped-photo.jpg" });
    const fileList = Object.assign([file], { item: (i: number) => (fileList as unknown as File[])[i] });

    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { files: fileList },
    });
    dropZone.dispatchEvent(event);

    // The mock returns fileName "real-photo.jpg" regardless of input path
    expect(await screen.findByText("real-photo.jpg")).toBeInTheDocument();
    expect(inspectImage).toHaveBeenCalledWith({
      path: "/tmp/dropped-photo.jpg",
      settings: expect.objectContaining({ targetFormat: "webp", quality: 85 }),
    });
  });

  it("imports Tauri drag/drop paths from the current webview", async () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    expect(mockOnDragDropEvent).toHaveBeenCalled();
    const calls = mockOnDragDropEvent.mock.calls as unknown as Array<[(event: {
      payload: { type: "drop"; paths: string[] };
    }) => Promise<void>]>;
    const handler = calls[0][0];
    await handler({
      payload: {
        type: "drop",
        paths: ["/tmp/tauri-dropped-photo.jpg"],
      },
    });

    expect(await screen.findByText("real-photo.jpg")).toBeInTheDocument();
    expect(inspectImage).toHaveBeenCalledWith({
      path: "/tmp/tauri-dropped-photo.jpg",
      settings: expect.objectContaining({ targetFormat: "webp", quality: 85 }),
    });
  });

  it("dropping file without usable path shows error and does not call inspectImage", async () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    const dropZone = document.querySelector("[data-testid='drop-zone']")!;
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
