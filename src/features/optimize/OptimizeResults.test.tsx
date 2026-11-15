import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { OptimizePage } from "./OptimizePage";
const mocks = vi.hoisted(() => ({
  onFileDrop: vi.fn(),
  open: vi.fn(), copyImages: vi.fn(), copyOutputsToDir: vi.fn(), uploadObject: vi.fn(),
}));
vi.mock("@/platform/desktop", () => ({ open: mocks.open, onFileDrop: mocks.onFileDrop, onImagesOpened: () => () => {} }));
vi.mock("../../api/backend", () => ({
  imageApi: {
    cancelImageTask: vi.fn(async () => {}),
    createOptimizerRun: vi.fn(async () => ({ runId: "run", outputDir: "/cache/run" })),
    inspectImage: vi.fn(async ({ path }) => ({ path, fileName: path.split("/").pop(), sourceFormat: "png", originalBytes: 1000, width: 20, height: 20 })),
    compressImage: vi.fn(async ({ sourcePath, outputFileName }) => ({ sourcePath, outputPath: `/cache/run/${outputFileName}`, outputFileName, originalBytes: 1000, outputBytes: 500, targetFormat: "png" })),
    readThumbnail: vi.fn(async () => ({ dataUrl: "data:image/png;base64,AA==" })),
    readComparisonImage: vi.fn(async () => ({ dataUrl: "data:image/png;base64,AA==", width: 20, height: 20 })),
    copyImages: mocks.copyImages, copyOutputsToDir: mocks.copyOutputsToDir,
  },
  uploadApi: { uploadObject: mocks.uploadObject },
  namingApi: { generateObjectKey: vi.fn(async ({ outputFileName }) => ({ objectKey: outputFileName })) },
}));
const profile = { id: "fake", name: "Test bucket", bucket: "test", endpoint: "https://s3.example.test", region: "auto", accessKeyId: "fake", pathStyle: true, defaultPrefix: "images" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.onFileDrop.mockReturnValue(() => {});
  mocks.open.mockImplementation(async (options) => options?.directory ? "/saved" : ["/one.png", "/two.png"]);
  mocks.copyImages.mockResolvedValue(undefined);
  mocks.copyOutputsToDir.mockResolvedValue(["/saved/one.png"]);
  mocks.uploadObject.mockImplementation(async ({ objectKey }) => ({ key: objectKey }));
});
async function start() {
  const user = userEvent.setup();
  render(<OptimizePage namingTemplate="{slug}.{ext}" activeProfile={profile} />);
  await user.click(screen.getByTestId("image-drop-zone"));
  await screen.findByText("2 of 2 ready");
  await act(async () => {});
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const openResults = screen.getByRole("button", { name: "View compression results" });
  await user.click(openResults);
  const dialog = within(await screen.findByRole("dialog", { name: "Compression results" }));
  return { user, dialog };
}
it("opens results only on request and copies one image or selected files", async () => {
  const { user, dialog } = await start();
  await user.click(dialog.getByRole("button", { name: "Copy selected images" }));
  await waitFor(() => expect(mocks.copyImages).toHaveBeenLastCalledWith(["/cache/run/one.png", "/cache/run/two.png"]));
  await user.click(dialog.getByRole("button", { name: "Copy image" }));
  expect(mocks.copyImages).toHaveBeenLastCalledWith(["/cache/run/one.png"]);
  await user.click(dialog.getByRole("checkbox", { name: "Select one.png" }));
  await user.click(dialog.getByRole("button", { name: "Copy selected images" }));
  expect(mocks.copyImages).toHaveBeenLastCalledWith(["/cache/run/two.png"]);
  await user.click(dialog.getByRole("button", { name: "Compare" }));
  const comparison = within(await screen.findByRole("dialog", { name: "Compare one.png" }));
  await user.click(comparison.getAllByRole("button", { name: "Close" })[0]);
  const restored = within(await screen.findByRole("dialog", { name: "Compression results" }));
  expect(restored.getByRole("checkbox", { name: "Select one.png" })).not.toBeChecked();
});
it("saves only the current image and uploads only selected images", async () => {
  const { user, dialog } = await start();
  await user.click(dialog.getByRole("button", { name: "Save image" }));
  await waitFor(() => expect(mocks.copyOutputsToDir).toHaveBeenCalledWith({ outputPaths: ["/cache/run/one.png"], targetDir: "/saved" }));
  await user.click(dialog.getByRole("checkbox", { name: "Select one.png" }));
  await user.click(dialog.getByRole("button", { name: "Save selected images" }));
  await waitFor(() => expect(mocks.copyOutputsToDir).toHaveBeenLastCalledWith({ outputPaths: ["/cache/run/two.png"], targetDir: "/saved" }));
  await user.click(dialog.getByRole("button", { name: "Upload selected" }));
  await waitFor(() => expect(mocks.uploadObject).toHaveBeenCalledTimes(1));
  expect(mocks.uploadObject).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: "/cache/run/two.png" }));
});
it("shows copy errors, allows retry, and reopens results after returning", async () => {
  const { user, dialog } = await start();
  mocks.copyImages.mockRejectedValueOnce(new Error("Clipboard unavailable"));
  await user.click(dialog.getByRole("button", { name: "Copy image" }));
  expect(await dialog.findByRole("alert")).toHaveTextContent("Clipboard unavailable");
  await user.click(dialog.getByRole("button", { name: "Copy image" }));
  expect(await dialog.findByText("Image copied to clipboard")).toBeVisible();
  await user.click(dialog.getByRole("button", { name: "Back to compression" }));
  await user.click(screen.getByRole("button", { name: "View compression results" }));
  expect(await screen.findByRole("dialog", { name: "Compression results" })).toBeVisible();
});

it("keeps the workspace available when images are dropped and recompressed", async () => {
  const user = userEvent.setup();
  render(<OptimizePage namingTemplate="{slug}.{ext}" activeProfile={profile} />);
  await act(async () => { mocks.onFileDrop.mock.calls[0][0](["/dropped.png"]); });
  await screen.findByText("1 of 1 ready");
  await act(async () => {});
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Batch format" })).toBeEnabled();
  await user.selectOptions(screen.getByRole("combobox", { name: "Batch format" }), "webp");
  await screen.findByText("1 of 1 ready");
  await act(async () => {});
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => { mocks.onFileDrop.mock.calls[0][0](["/second.png"]); });
  await screen.findByText("2 of 2 ready");
  await act(async () => {});
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "View compression results" })).toBeEnabled();
});
