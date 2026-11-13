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

  it("loads both full-resolution images only when mounted", async () => {
    readComparisonImage
      .mockResolvedValueOnce({ dataUrl: "data:image/png;base64,original", width: 4000, height: 3000 })
      .mockResolvedValueOnce({ dataUrl: "data:image/png;base64,compressed", width: 4000, height: 3000 });

    render(<ImageComparison originalPath="/photos/source.jpg" compressedPath="/cache/output.webp" />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading full-resolution images");
    expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(4);
    const taskId = readComparisonImage.mock.calls[0][0].taskId;
    expect(taskId).toEqual(expect.stringMatching(/^comparison:/));
    expect(readComparisonImage).toHaveBeenNthCalledWith(1, { taskId, path: "/photos/source.jpg" });
    expect(readComparisonImage).toHaveBeenNthCalledWith(2, { taskId, path: "/cache/output.webp" });
    expect(await screen.findByAltText("Original full-resolution preview")).toHaveAttribute(
      "src",
      "data:image/png;base64,original",
    );
    expect(screen.getAllByText("4000 × 3000 px")).toHaveLength(2);
  });

  it("switches to native pixel dimensions and keeps both panes in sync", async () => {
    readComparisonImage.mockResolvedValue({
      dataUrl: "data:image/png;base64,pixels",
      width: 2400,
      height: 1600,
    });
    const user = userEvent.setup();
    render(<ImageComparison originalPath="source.jpg" compressedPath="output.webp" />);
    await screen.findByAltText("Original full-resolution preview");

    await user.click(screen.getByRole("button", { name: "100%" }));
    const originalImage = screen.getByAltText("Original full-resolution preview");
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
      const stale = { dataUrl: "data:image/png;base64,stale", width: 1, height: 1 };
      finishOriginal(stale);
      finishCompressed(stale);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Loading full-resolution");
    expect(screen.queryByAltText("Original full-resolution preview")).not.toBeInTheDocument();
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
      dataUrl: "data:image/png;base64,recovered",
      width: 800,
      height: 600,
    });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(readComparisonImage).toHaveBeenCalledTimes(4));
    expect(readComparisonImage.mock.calls[2][0].taskId).not.toBe(failedTaskId);
    expect(readComparisonImage.mock.calls[3][0].taskId).toBe(readComparisonImage.mock.calls[2][0].taskId);
    expect(await screen.findByAltText("Compressed full-resolution preview")).toBeInTheDocument();
  });
});
