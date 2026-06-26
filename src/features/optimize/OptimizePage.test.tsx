import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OptimizePage } from "./OptimizePage";
import { describe, it, expect, vi } from "vitest";

const { inspectImage } = vi.hoisted(() => ({
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
      quality: 68,
      maxWidth: 1600,
      maxHeight: 1600,
      allowUpscale: false,
      removeGps: true,
    },
  })),
}));

vi.mock("@tauri-apps/plugin-dialog", async () => ({
  open: vi.fn(async () => ["/tmp/real-photo.jpg"]),
}));

vi.mock("../../api/tauri", async () => ({
  tauriApi: {
    inspectImage,
  },
  uploadApi: {
    uploadObject: vi.fn(),
  },
}));

describe("OptimizePage", () => {
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
      settings: expect.objectContaining({ targetFormat: "webp", quality: 68 }),
    });
    expect(await screen.findByText("real-photo.jpg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compress" })).toBeEnabled();
  });
});
