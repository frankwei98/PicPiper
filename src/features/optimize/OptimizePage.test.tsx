import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      key: "images/2026/06/real-photo-abcdef12.webp",
      size: 240_000,
      publicUrl: "https://cdn.example.com/images/2026/06/real-photo-abcdef12.webp",
      isImage: true,
    })),
    generateObjectKey: vi.fn(async () => ({
      objectKey: "images/2026/06/real-photo-abcdef12.webp",
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
    key: "images/2026/06/real-photo-abcdef12.webp",
    size: 240_000,
    publicUrl: "https://cdn.example.com/images/2026/06/real-photo-abcdef12.webp",
    isImage: true,
  }));
  generateObjectKey.mockImplementation(async () => ({
    objectKey: "images/2026/06/real-photo-abcdef12.webp",
  }));
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

  it("starts empty and asks the user to choose images", () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    expect(screen.getByRole("heading", { name: "Compress" })).toBeInTheDocument();
    expect(screen.queryByText("Optimize")).not.toBeInTheDocument();
    expect(screen.getByText(/choose images/i)).toBeInTheDocument();
    expect(screen.queryByText("photo-01.jpg")).not.toBeInTheDocument();
    expect(screen.queryByText("/sample/photo-01.jpg")).not.toBeInTheDocument();
  });

  it("opens the image picker when the drop zone is clicked", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByTestId("drop-zone"));

    expect(mockDialogOpen).toHaveBeenCalledWith({
      multiple: true,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "avif"] }],
    });
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

  it("keeps quality controls in a constrained second column at narrow window widths", () => {
    const { container } = render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    expect(container.querySelector("header")).toHaveClass(
      "grid-cols-[minmax(0,1fr)_minmax(12rem,25%)]",
      "items-end",
    );
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
        outputFileName: "real-photo.webp",
        settings: expect.objectContaining({ targetFormat: "webp", quality: 85, removeGps: true }),
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
    expect(await screen.findByText(/1.2 MB.*240 KB/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("slider", { name: /quality/i }), { target: { value: "60" } });

    expect(await screen.findByText(/1.2 MB.*120 KB/)).toBeInTheDocument();
    expect(screen.queryByText(/1.2 MB.*240 KB/)).not.toBeInTheDocument();
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

  it("changing format after compression does not produce stale -2 suffix", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    // Import and compress
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await screen.findByText(/1.2 MB.*240 KB/);
    compressImage.mockClear();

    // Change format - should use fresh filename claim, not stale -2
    await user.selectOptions(screen.getByLabelText(/format for real-photo\.jpg/i), "webp");

    expect(compressImage).toHaveBeenCalledTimes(1);
    expect(compressImage).toHaveBeenCalledWith(
      expect.objectContaining({
        outputFileName: "real-photo.webp",
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

    expect(await screen.findByText(/quality does not apply to png output/i)).toBeInTheDocument();
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
      "photo.webp",
      "photo-2.webp",
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

    // First import: photo.jpg -> compresses to photo.webp
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await waitFor(() => {
      expect(compressImage).toHaveBeenCalledTimes(1);
    });
    expect(compressImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ outputFileName: "photo.webp" }),
    );

    // Second import: another photo.jpg appended
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await waitFor(() => {
      expect(compressImage).toHaveBeenCalledTimes(2);
    });

    // The second import should use photo-2.webp, not overwrite photo.webp
    const calls = compressImage.mock.calls as unknown as Array<[{ outputFileName: string }]>;
    expect(calls[1][0].outputFileName).toBe("photo-2.webp");
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
    expect(await screen.findByText("real-photo.jpg")).toBeInTheDocument();

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
      outputPaths: ["/tmp/pic-piper/run-1/real-photo.webp"],
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
        sourcePath: "/tmp/pic-piper/run-1/real-photo.webp",
        outputFileName: "real-photo.webp",
        ext: "webp",
        prefix: "images/2026/06",
        namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
      }),
    );
    expect(uploadObject).toHaveBeenCalledWith(
      expect.objectContaining({
        profile,
        sourcePath: "/tmp/pic-piper/run-1/real-photo.webp",
        objectKey: "images/2026/06/real-photo-abcdef12.webp",
        contentType: "image/webp",
      }),
    );
    expect(onUploadedToS3).toHaveBeenCalledWith({
      profileId: "p1",
      prefix: "images/2026/06",
      highlightedKeys: ["images/2026/06/real-photo-abcdef12.webp"],
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
    await screen.findByText(/1.2 MB.*240 KB/);
    await user.click(screen.getByRole("button", { name: "Upload to S3" }));
    await screen.findByText(/uploading 1 image/i);

    expect(screen.getByRole("slider", { name: /quality/i })).toBeDisabled();
    expect(screen.getByTestId("drop-zone")).toBeDisabled();
    expect(screen.getByLabelText(/format for real-photo\.jpg/i)).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /remove real-photo\.jpg from queue/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /^remove real-photo\.jpg$/i })).toBeDisabled();

    finishUpload({
      key: "images/2026/06/real-photo-abcdef12.webp",
      size: 240_000,
      publicUrl: "https://cdn.example.com/images/2026/06/real-photo-abcdef12.webp",
      isImage: true,
    });
    await waitFor(() => expect(uploadObject).toHaveBeenCalledTimes(1));
  });

  it("defers a queued quality re-compression until the active upload finishes", async () => {
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
    await screen.findByText(/1.2 MB.*240 KB/);

    fireEvent.change(screen.getByRole("slider", { name: /quality/i }), {
      target: { value: "70" },
    });
    await user.click(screen.getByRole("button", { name: "Upload to S3" }));
    await screen.findByText(/uploading 1 image/i);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
    });
    expect(compressImage).toHaveBeenCalledTimes(1);

    finishUpload({
      key: "images/2026/06/real-photo-abcdef12.webp",
      size: 240_000,
      publicUrl: "https://cdn.example.com/images/2026/06/real-photo-abcdef12.webp",
      isImage: true,
    });
    await waitFor(() => expect(screen.queryByText(/uploading 1 image/i)).not.toBeInTheDocument());
    await waitFor(() => expect(compressImage).toHaveBeenCalledTimes(2));
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

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    const uploadNew = await screen.findByRole("button", { name: "Upload 1 new image(s) to S3" });
    await user.click(uploadNew);

    await waitFor(() => expect(uploadObject).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Retry 1 failed upload(s)" })).toBeInTheDocument();
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

  it("does not duplicate imports when both DOM drop and Tauri drop fire", async () => {
    // The default mock already simulates Tauri registering successfully
    // (mockOnDragDropEvent resolves with a cleanup function)
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    // Wait for Tauri registration
    await waitFor(() => {
      expect(mockOnDragDropEvent).toHaveBeenCalled();
    });

    // Wait a tick for the Tauri registration promise to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now simulate a DOM drop - should be skipped since Tauri is active
    const dropZone = document.querySelector("[data-testid='drop-zone']")!;
    const file = new File(["dummy"], "dropped-photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "path", { value: "/tmp/dom-dropped.jpg" });
    const fileList = Object.assign([file], { item: (i: number) => (fileList as unknown as File[])[i] });
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { files: fileList },
    });
    dropZone.dispatchEvent(event);

    // Wait a bit - inspectImage should NOT be called since DOM drop was skipped
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(inspectImage).not.toHaveBeenCalled();

    // Now simulate Tauri drop via the registered handler - this should work
    const calls = mockOnDragDropEvent.mock.calls as unknown as Array<[(event: {
      payload: { type: string; paths: string[] };
    }) => Promise<void>]>;
    await calls[0][0]({
      payload: {
        type: "drop",
        paths: ["/tmp/tauri-dropped.jpg"],
      },
    });

    expect(await screen.findByText("real-photo.jpg")).toBeInTheDocument();
    expect(inspectImage).toHaveBeenCalledTimes(1);
    expect(inspectImage).toHaveBeenCalledWith({
      path: "/tmp/tauri-dropped.jpg",
      settings: expect.objectContaining({ targetFormat: "webp", quality: 85 }),
    });
  });

  it("uses per-item compressImage and never calls compressBatch", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await screen.findByText(/1.2 MB.*240 KB/);

    // compressImage was called (per-item API)
    expect(compressImage).toHaveBeenCalled();
    // The mock does not expose compressBatch — if OptimizePage tried to call
    // it, the test would fail with "compressBatch is not a function".
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
