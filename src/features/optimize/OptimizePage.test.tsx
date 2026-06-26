import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OptimizePage } from "./OptimizePage";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { inspectImage, compressBatch, copyOutputsToDir, mockDialogOpen, mockOnDragDropEvent, uploadObject, generateObjectKey } = vi.hoisted(() => {
  const mockDialogOpen = vi.fn(async (..._args: unknown[]) => ["/tmp/real-photo.jpg"]);
  return {
    inspectImage: vi.fn(async () => ({
      id: "real-photo",
      sourcePath: "/tmp/real-photo.jpg",
      fileName: "real-photo.jpg",
      sourceFormat: "jpg",
      originalBytes: 1_200_000,
      estimatedBytes: 260_000,
      status: "ready",
      settings: {
        targetFormat: "webp",
        quality: 85,
        removeGps: true,
      },
    })),
    compressBatch: vi.fn(async () => ({
      runId: "run-1",
      outputDir: "/tmp/pic-piper/run-1",
      items: [
        {
          id: "real-photo",
          result: {
            sourcePath: "/tmp/real-photo.jpg",
            outputPath: "/tmp/pic-piper/run-1/real-photo.webp",
            outputFileName: "real-photo.webp",
            originalBytes: 1_200_000,
            outputBytes: 240_000,
            targetFormat: "webp",
          },
        },
      ],
    })),
    copyOutputsToDir: vi.fn(async () => ["/tmp/saved/real-photo.webp"]),
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
    inspectImage,
    compressBatch,
    copyOutputsToDir,
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

  it("keeps Compress disabled until at least one image is inspected", () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    expect(screen.getByRole("button", { name: "Compress" })).toBeDisabled();
  });

  it("imports selected image files through backend inspection", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    await user.click(screen.getByRole("button", { name: /choose images/i }));

    expect(inspectImage).toHaveBeenCalledWith({
      path: "/tmp/real-photo.jpg",
      settings: expect.objectContaining({ targetFormat: "webp", quality: 85 }),
    });
    expect(await screen.findByText("real-photo.jpg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compress" })).toBeEnabled();
  });

  it("calls compressBatch and shows real compression results", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    // Import an image
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await screen.findByText("real-photo.jpg");

    // Click Compress
    await user.click(screen.getByRole("button", { name: "Compress" }));

    expect(compressBatch).toHaveBeenCalled();

    // Should show results with real output filename and sizes
    expect(await screen.findByText("real-photo.webp")).toBeInTheDocument();
    expect(screen.getByText(/1.2 MB.*240 KB/)).toBeInTheDocument();
  });

  it("sends imported image in compressBatch items (not an empty array)", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    // Import an image
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await screen.findByText("real-photo.jpg");

    // Click Compress
    await user.click(screen.getByRole("button", { name: "Compress" }));

    expect(compressBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "real-photo",
            sourcePath: "/tmp/real-photo.jpg",
            outputFileName: "real-photo.webp",
            settings: expect.objectContaining({ targetFormat: "webp", quality: 85 }),
          }),
        ]),
      }),
    );
  });

  it("Save to local folder opens directory picker and copies files", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    // Import and compress
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await screen.findByText("real-photo.jpg");
    await user.click(screen.getByRole("button", { name: "Compress" }));
    await screen.findByText("real-photo.webp");

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

    // Import and compress
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await screen.findByText("real-photo.jpg");
    await user.click(screen.getByRole("button", { name: "Compress" }));
    await screen.findByText("real-photo.webp");

    // Save to local folder
    await user.click(screen.getByRole("button", { name: "Save to local folder" }));

    // Should show success message in the page
    expect(await screen.findByText(/Saved 1 file\(s\) to \/tmp\/saved/)).toBeInTheDocument();
    // Should NOT call window.alert
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it("Apply preset applies preset settings and compressBatch includes them", async () => {
    const preset = {
      id: "preset-1",
      name: "High Quality",
      targetFormat: "avif" as const,
      quality: 85,
      removeGps: true,
    };
    const user = userEvent.setup();
    render(
      <OptimizePage
        namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}"
        presets={[preset]}
      />,
    );

    // Import an image
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await screen.findByText("real-photo.jpg");

    // Change per-image quality away from default
    const qualitySlider = screen.getByRole("slider");
    fireEvent.change(qualitySlider, { target: { value: "50" } });

    // Select the preset in the dropdown and click Apply preset
    const presetSelect = screen.getByLabelText(/preset/i);
    await user.selectOptions(presetSelect, "preset-1");
    await user.click(screen.getByRole("button", { name: /apply preset/i }));

    // Verify the item's settings were updated to the preset values
    expect(screen.getByText(/AVIF/i)).toBeInTheDocument();

    // Click Compress and verify preset settings are sent
    await user.click(screen.getByRole("button", { name: "Compress" }));

    expect(compressBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "real-photo",
            settings: expect.objectContaining({
              targetFormat: "avif",
              quality: 85,
            }),
          }),
        ]),
      }),
    );
  });

  it("Apply preset with no presets configured applies DEFAULT_SETTINGS", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    // Import an image
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await screen.findByText("real-photo.jpg");

    // Change per-image quality away from default
    const qualitySlider = screen.getByRole("slider");
    fireEvent.change(qualitySlider, { target: { value: "30" } });

    // Click Apply preset (no presets prop, so DEFAULT_SETTINGS should be used)
    await user.click(screen.getByRole("button", { name: /apply preset/i }));

    // Click Compress and verify default settings are restored
    await user.click(screen.getByRole("button", { name: "Compress" }));

    expect(compressBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "real-photo",
            settings: expect.objectContaining({
              targetFormat: "webp",
              quality: 85,
            }),
          }),
        ]),
      }),
    );
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

    // Import and compress
    await user.click(screen.getByRole("button", { name: /choose images/i }));
    await screen.findByText("real-photo.jpg");
    await user.click(screen.getByRole("button", { name: "Compress" }));
    await screen.findByText("real-photo.webp");

    // Click Upload to S3
    await user.click(screen.getByRole("button", { name: "Upload to S3" }));

    expect(generateObjectKey).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: "/tmp/pic-piper/run-1/real-photo.webp",
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
      profile,
      prefix: "images/2026/06",
      highlightedKeys: ["images/2026/06/real-photo-abcdef12.webp"],
    });
  });

  it("dropping file with usable path calls inspectImage", async () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    const dropZone = document.querySelector(".drop-zone")!;
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

    const dropZone = document.querySelector(".drop-zone")!;
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
