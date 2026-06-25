import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OptimizePage } from "./OptimizePage";
import { vi, describe, it, expect } from "vitest";

vi.mock("../../api/tauri", async () => {
  return {
    uploadApi: {
      uploadObject: vi.fn(async (request: { objectKey: string }) => ({
        key: request.objectKey,
        size: 720_000,
        publicUrl: `https://cdn.example.com/${request.objectKey}`,
        isImage: true,
      })),
    },
  };
});

describe("OptimizePage", () => {
  it("shows per-image size feedback and lets quality change", () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    expect(screen.getByText(/photo-01.jpg/)).toBeInTheDocument();
    expect(screen.getByText(/4.2 MB => 720 KB/)).toBeInTheDocument();

    const slider = screen.getByRole("slider", { name: /Quality 68%/ });
    fireEvent.change(slider, { target: { value: "50" } });

    expect(screen.getByText(/Quality 50%/)).toBeInTheDocument();
  });

  it("shows per-image size feedback and then compression result actions", async () => {
    const user = userEvent.setup();
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    expect(screen.getByText(/photo-01.jpg/)).toBeInTheDocument();
    expect(screen.getByText(/4.2 MB => 720 KB/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Compress" }));

    expect(screen.getByRole("heading", { name: "Compression results" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to local folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload to S3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to edit settings" })).toBeInTheDocument();
  });

  it("notifies parent after explicit Upload to S3", async () => {
    const user = userEvent.setup();
    const onUploadedToS3 = vi.fn();
    render(
      <OptimizePage
        activeProfile={{
          id: "p1",
          name: "Personal S3",
          bucket: "images",
          endpoint: "https://s3.example.com",
          region: "auto",
          defaultPrefix: "2026/06",
          publicBaseUrl: "https://cdn.example.com",
        }}
        namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}"
        onUploadedToS3={onUploadedToS3}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Compress" }));
    await user.click(screen.getByRole("button", { name: "Upload to S3" }));

    expect(onUploadedToS3).toHaveBeenCalledWith({
      prefix: "2026/06",
      highlightedKeys: ["2026/06/photo-01.webp"],
    });
  });
});
