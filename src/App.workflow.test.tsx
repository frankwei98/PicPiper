import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  upload: vi.fn(),
  copy: vi.fn(),
  onFileDrop: vi.fn(() => vi.fn()),
  load: vi.fn(),
}));
vi.mock("@/platform/desktop", () => ({ open: mocks.open, onFileDrop: mocks.onFileDrop }));
vi.mock("./api/backend", () => ({
  settingsApi: { loadSettings: mocks.load, saveSettings: vi.fn(), saveS3Secret: vi.fn() },
  imageApi: {
    cancelImageTask: vi.fn(async () => {}),
    inspectImage: vi.fn(async () => ({ fileName: "photo.jpg", originalBytes: 1000, sourceFormat: "jpg" })),
    createOptimizerRun: vi.fn(async () => ({ runId: "r", outputDir: "/cache/r" })),
    compressImage: vi.fn(async () => ({ outputFileName: "photo.jpg", outputPath: "/cache/r/photo.jpg", outputBytes: 500 })),
    readThumbnail: vi.fn(async () => ({ dataUrl: "data:image/png;base64,test" })),
    copyOutputsToDir: mocks.copy,
  },
  namingApi: { generateObjectKey: vi.fn(async () => ({ objectKey: "images/photo.jpg" })) },
  uploadApi: { uploadObject: mocks.upload },
  galleryApi: { listObjects: vi.fn(async () => ({ objects: [] })) },
}));

const profile = {
  id: "a", name: "Personal", endpoint: "https://s3.example.com", bucket: "photos",
  region: "auto", accessKeyId: "test-key", credentialRef: "s3:a", defaultPrefix: "images", pathStyle: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue({ profiles: [profile], defaultProfileId: "a", namingTemplate: "{slug}.{ext}" });
  mocks.open.mockImplementation(async (options) => options.directory ? "/saved" : ["/photo.jpg"]);
  mocks.copy.mockResolvedValue(["/saved/photo.jpg"]);
  mocks.upload.mockResolvedValue({ key: "images/photo.jpg", size: 500, isImage: true });
});

describe("application workflow", () => {
  it("retains compression results and settings drafts when switching tabs", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("image-drop-zone"));
    await screen.findByRole("button", { name: "Save to local folder" });
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    const name = screen.getByLabelText("Profile name");
    await user.clear(name);
    await user.type(name, "Unsaved draft");
    await user.click(screen.getByRole("tab", { name: "Compress" }));
    expect(screen.getByText("photo.jpg")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save to local folder" }));
    expect(mocks.copy).toHaveBeenCalledWith({ outputPaths: ["/cache/r/photo.jpg"], targetDir: "/saved" });
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByLabelText("Profile name")).toHaveValue("Unsaved draft");
  });

  it("lets a background upload finish without hijacking navigation or losing local results", async () => {
    const user = userEvent.setup();
    let complete!: (value: unknown) => void;
    mocks.upload.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    render(<App />);
    await user.click(screen.getByTestId("image-drop-zone"));
    await user.click(await screen.findByRole("button", { name: "Upload to S3" }));
    await waitFor(() => expect(mocks.upload).toHaveBeenCalled());
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await act(async () => complete({ key: "images/photo.jpg", size: 500, isImage: true }));
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Compress" }));
    expect(screen.getByRole("button", { name: "Save to local folder" })).toBeEnabled();
    expect(screen.getByText(/Uploaded 1 image\(s\) to Personal · photos/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "View uploaded images" }));
    expect(screen.getByRole("tab", { name: "S3 Gallery" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Compress" }));
    await user.click(screen.getByRole("button", { name: "Remove photo.jpg" }));
    expect(screen.queryByRole("button", { name: "View uploaded images" })).not.toBeInTheDocument();
  });
});
