import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { imageApi, type ReadComparisonImageResponse } from "../../api/backend";
import { ImageComparison } from "./ImageComparison";

vi.mock("../../api/backend", () => ({
  imageApi: {
    readComparisonImage: vi.fn(),
    cancelImageTask: vi.fn(async () => {}),
  },
}));

const readComparisonImage = vi.mocked(imageApi.readComparisonImage);

describe("ImageComparison", () => {
  beforeEach(() => {
    readComparisonImage.mockReset();
    vi.mocked(imageApi.cancelImageTask).mockClear();
    Element.prototype.scrollTo = vi.fn();
  });

  it("loads both bounded previews on mount", async () => {
    readComparisonImage
      .mockResolvedValueOnce({ url: "picpiper-preview://localhost/original", width: 4000, height: 3000, snapshotId: "original-snapshot" })
      .mockResolvedValueOnce({ url: "picpiper-preview://localhost/compressed", width: 4000, height: 3000, snapshotId: "compressed-snapshot" });

    render(<ImageComparison originalPath="/photos/source.jpg" compressedPath="/cache/output.webp" />);

    expect(screen.getByRole("status")).toHaveTextContent("Updating preview");
    expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(4);
    const taskId = readComparisonImage.mock.calls[0][0].taskId;
    expect(taskId).toEqual(expect.stringMatching(/^comparison:/));
    expect(readComparisonImage).toHaveBeenNthCalledWith(1, { taskId, path: "/photos/source.jpg", maxSize: 1280 });
    expect(readComparisonImage).toHaveBeenNthCalledWith(2, { taskId, path: "/cache/output.webp", maxSize: 1280 });
    expect(await screen.findByAltText("Original")).toHaveAttribute(
      "src",
      "picpiper-preview://localhost/original",
    );
    expect(screen.getAllByText("4000 × 3000 px")).toHaveLength(2);
  });

  it("switches to native pixel dimensions and keeps both panes in sync", async () => {
    const preview = { url: "picpiper-preview://localhost/pixels", width: 2400, height: 1600 };
    readComparisonImage
      .mockResolvedValueOnce({ ...preview, snapshotId: "original-snapshot" })
      .mockResolvedValueOnce({ ...preview, snapshotId: "compressed-snapshot" })
      .mockResolvedValue(preview);
    const user = userEvent.setup();
    render(<ImageComparison originalPath="source.jpg" compressedPath="output.webp" />);
    await screen.findByAltText("Original");

    await user.click(screen.getByRole("button", { name: "100%" }));
    const originalImage = await screen.findByAltText("Original full-resolution preview");
    const taskId = readComparisonImage.mock.calls[2][0].taskId;
    expect(readComparisonImage.mock.calls.slice(2)).toEqual([
      [{ taskId, snapshotId: "original-snapshot" }],
      [{ taskId, snapshotId: "compressed-snapshot" }],
    ]);
    expect(originalImage).toHaveStyle({ width: "2400px", height: "1600px" });
    expect(screen.getByText("100% scale. Scroll either image to compare details.")).toBeInTheDocument();

    const originalPane = screen.getByTestId("original-comparison-pane");
    const compressedPane = screen.getByTestId("compressed-comparison-pane");
    Object.defineProperty(originalPane, "scrollLeft", { value: 475, writable: true });
    Object.defineProperty(originalPane, "scrollTop", { value: 220, writable: true });
    fireEvent.scroll(originalPane);
    expect(compressedPane.scrollLeft).toBe(475);
    expect(compressedPane.scrollTop).toBe(220);
  });

  it("reuses both preview sizes across zoom toggles and releases them on close", async () => {
    const fit = { url: "picpiper-preview://localhost/fit", width: 2400, height: 1600 };
    const actual = { ...fit, url: "picpiper-preview://localhost/actual" };
    readComparisonImage
      .mockResolvedValueOnce({ ...fit, snapshotId: "original-snapshot" })
      .mockResolvedValueOnce({ ...fit, snapshotId: "compressed-snapshot" })
      .mockResolvedValueOnce(actual).mockResolvedValueOnce(actual)
      .mockRejectedValue(new Error("Source file no longer exists"));
    const user = userEvent.setup();
    const view = render(<ImageComparison originalPath="source.jpg" compressedPath="output.webp" />);
    expect(await screen.findByAltText("Original")).toHaveAttribute("src", fit.url);
    await user.click(screen.getByRole("button", { name: "100%" }));
    expect(await screen.findByAltText("Original full-resolution preview")).toHaveAttribute("src", actual.url);

    await user.click(screen.getByRole("button", { name: "Fit" }));
    expect(screen.getByAltText("Original")).toHaveAttribute("src", fit.url);
    await user.click(screen.getByRole("button", { name: "100%" }));
    expect(screen.getByAltText("Original full-resolution preview")).toHaveAttribute("src", actual.url);
    expect(readComparisonImage).toHaveBeenCalledTimes(4);
    expect(imageApi.cancelImageTask).not.toHaveBeenCalled();

    view.unmount();
    expect(imageApi.cancelImageTask).toHaveBeenCalledTimes(2);
    expect(imageApi.cancelImageTask).toHaveBeenCalledWith({ taskId: readComparisonImage.mock.calls[0][0].taskId });
    expect(imageApi.cancelImageTask).toHaveBeenCalledWith({ taskId: readComparisonImage.mock.calls[2][0].taskId });
  });

  it("does not load 100% if the user returns to Fit before snapshots are ready", async () => {
    let finishFit!: (image: ReadComparisonImageResponse) => void;
    const image = { url: "picpiper-preview://localhost/preview", width: 2400, height: 1600 };
    readComparisonImage
      .mockImplementationOnce(() => new Promise((resolve) => { finishFit = resolve; }))
      .mockResolvedValueOnce({ ...image, snapshotId: "compressed-snapshot" })
      .mockResolvedValue(image);
    const user = userEvent.setup();
    render(<ImageComparison originalPath="source.jpg" compressedPath="output.webp" />);
    await user.click(screen.getByRole("button", { name: "100%" }));
    await user.click(screen.getByRole("button", { name: "Fit" }));
    await act(async () => { finishFit({ ...image, snapshotId: "original-snapshot" }); });
    expect(await screen.findByAltText("Original")).toBeInTheDocument();
    expect(readComparisonImage).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: "100%" }));
    expect(await screen.findByAltText("Original full-resolution preview")).toBeInTheDocument();
    expect(readComparisonImage).toHaveBeenCalledTimes(4);
  });

  it("waits for Fit's snapshot before loading 100% and retries a failed Fit", async () => {
    let failFit!: (error: Error) => void;
    const image = { url: "picpiper-preview://localhost/preview", width: 2400, height: 1600 };
    readComparisonImage
      .mockImplementationOnce(() => new Promise((_, reject) => { failFit = reject; }))
      .mockResolvedValueOnce({ ...image, snapshotId: "abandoned-compressed" })
      .mockResolvedValueOnce({ ...image, snapshotId: "original-snapshot" })
      .mockResolvedValueOnce({ ...image, snapshotId: "compressed-snapshot" })
      .mockResolvedValue(image);
    const user = userEvent.setup();
    render(<ImageComparison originalPath="source.jpg" compressedPath="output.webp" />);
    await user.click(screen.getByRole("button", { name: "100%" }));
    expect(readComparisonImage).toHaveBeenCalledTimes(2);
    await act(async () => { failFit(new Error("Source unavailable")); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Source unavailable");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByAltText("Original full-resolution preview")).toBeInTheDocument();
    expect(readComparisonImage.mock.calls.slice(4).map(([request]) => request)).toEqual([
      { taskId: expect.any(String), snapshotId: "original-snapshot" },
      { taskId: expect.any(String), snapshotId: "compressed-snapshot" },
    ]);
  });

  it("ignores clamped scroll echoes while allowing either pane to drive scrolling", async () => {
    readComparisonImage
      .mockResolvedValueOnce({ url: "picpiper-preview://localhost/original", width: 2400, height: 1600, snapshotId: "original-snapshot" })
      .mockResolvedValueOnce({ url: "picpiper-preview://localhost/compressed", width: 800, height: 600, snapshotId: "compressed-snapshot" })
      .mockResolvedValueOnce({ url: "picpiper-preview://localhost/full-original", width: 2400, height: 1600 })
      .mockResolvedValueOnce({ url: "picpiper-preview://localhost/full-compressed", width: 800, height: 600 });
    const user = userEvent.setup();
    render(<ImageComparison originalPath="source.jpg" compressedPath="output.webp" />);
    await screen.findByAltText("Original");
    await user.click(screen.getByRole("button", { name: "100%" }));
    await screen.findByAltText("Original full-resolution preview");
    const originalPane = screen.getByTestId("original-comparison-pane");
    const compressedPane = screen.getByTestId("compressed-comparison-pane");
    let compressedLeft = 0;
    let compressedTop = 0;
    Object.defineProperties(compressedPane, {
      scrollLeft: {
        get: () => compressedLeft,
        set: (value: number) => { compressedLeft = Math.max(0, Math.min(200, value)); },
      },
      scrollTop: {
        get: () => compressedTop,
        set: (value: number) => { compressedTop = Math.max(0, Math.min(100, value)); },
      },
    });

    originalPane.scrollLeft = 900;
    originalPane.scrollTop = 500;
    fireEvent.scroll(originalPane);
    expect(compressedPane.scrollLeft).toBe(200);
    expect(compressedPane.scrollTop).toBe(100);
    fireEvent.scroll(compressedPane);
    expect(originalPane.scrollLeft).toBe(900);
    expect(originalPane.scrollTop).toBe(500);

    // A genuine scroll can arrive before a pending programmatic echo.
    originalPane.scrollLeft = 1000;
    originalPane.scrollTop = 600;
    fireEvent.scroll(originalPane);
    compressedPane.scrollLeft = 120;
    compressedPane.scrollTop = 60;
    fireEvent.scroll(compressedPane);
    expect(originalPane.scrollLeft).toBe(120);
    expect(originalPane.scrollTop).toBe(60);
    fireEvent.scroll(originalPane);
    expect(compressedPane.scrollLeft).toBe(120);
    expect(compressedPane.scrollTop).toBe(60);

    originalPane.scrollLeft = 700;
    originalPane.scrollTop = 300;
    fireEvent.scroll(originalPane);
    fireEvent.scroll(compressedPane);
    expect(originalPane.scrollLeft).toBe(700);
    expect(originalPane.scrollTop).toBe(300);
  });

  it("cancels both pending reads when closed", () => {
    readComparisonImage.mockImplementation(() => new Promise(() => {}));
    const view = render(<ImageComparison originalPath="source.avif" compressedPath="output.avif" />);
    const taskId = readComparisonImage.mock.calls[0][0].taskId;
    expect(taskId).toEqual(expect.stringMatching(/^comparison:/));
    expect(readComparisonImage.mock.calls[1][0].taskId).toBe(taskId);
    view.unmount();
    expect(imageApi.cancelImageTask).toHaveBeenCalledExactlyOnceWith({ taskId });
  });

  it("cancels replaced reads and ignores their late results", async () => {
    let finishOriginal!: (image: ReadComparisonImageResponse) => void;
    let finishCompressed!: (image: ReadComparisonImageResponse) => void;
    readComparisonImage
      .mockImplementationOnce(() => new Promise((resolve) => { finishOriginal = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishCompressed = resolve; }))
      .mockImplementation(() => new Promise(() => {}));
    const view = render(<ImageComparison originalPath="old.jpg" compressedPath="old.webp" />);
    const oldTaskId = readComparisonImage.mock.calls[0][0].taskId;
    view.rerender(<ImageComparison originalPath="new.jpg" compressedPath="new.webp" />);
    expect(imageApi.cancelImageTask).toHaveBeenCalledWith({ taskId: oldTaskId });
    const newTaskId = readComparisonImage.mock.calls[2][0].taskId;
    expect(newTaskId).toEqual(expect.stringMatching(/^comparison:/));
    expect(newTaskId).not.toBe(oldTaskId);
    expect(readComparisonImage.mock.calls[3][0].taskId).toBe(newTaskId);
    await act(async () => {
      const stale = { url: "picpiper-preview://localhost/stale", width: 1, height: 1 };
      finishOriginal(stale);
      finishCompressed(stale);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Updating preview");
    expect(screen.queryByAltText("Original")).not.toBeInTheDocument();
    view.unmount();
    expect(imageApi.cancelImageTask).toHaveBeenCalledWith({ taskId: newTaskId });
  });

  it("shows a useful error and retries both reads", async () => {
    readComparisonImage.mockRejectedValueOnce(new Error("File is no longer available"));
    render(<ImageComparison originalPath="source.jpg" compressedPath="output.webp" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("File is no longer available");
    const failedTaskId = readComparisonImage.mock.calls[0][0].taskId;
    expect(imageApi.cancelImageTask).toHaveBeenCalledExactlyOnceWith({ taskId: failedTaskId });
    readComparisonImage.mockResolvedValue({
      url: "picpiper-preview://localhost/recovered",
      width: 800,
      height: 600,
    });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(readComparisonImage).toHaveBeenCalledTimes(4));
    expect(readComparisonImage.mock.calls[2][0].taskId).not.toBe(failedTaskId);
    expect(readComparisonImage.mock.calls[3][0].taskId).toBe(readComparisonImage.mock.calls[2][0].taskId);
    expect(await screen.findByAltText("Compressed")).toBeInTheDocument();
  });
});
