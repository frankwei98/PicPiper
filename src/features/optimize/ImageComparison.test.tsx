import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tauriApi } from "../../api/tauri";
import { ImageComparison } from "./ImageComparison";

vi.mock("../../api/tauri", () => ({
  tauriApi: {
    readComparisonImage: vi.fn(),
  },
}));

const readComparisonImage = vi.mocked(tauriApi.readComparisonImage);

describe("ImageComparison", () => {
  beforeEach(() => {
    readComparisonImage.mockReset();
    Element.prototype.scrollTo = vi.fn();
  });

  it("loads both full-resolution images only when mounted", async () => {
    readComparisonImage
      .mockResolvedValueOnce({ dataUrl: "data:image/png;base64,original", width: 4000, height: 3000 })
      .mockResolvedValueOnce({ dataUrl: "data:image/png;base64,compressed", width: 4000, height: 3000 });

    render(<ImageComparison originalPath="/photos/source.jpg" compressedPath="/cache/output.webp" />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading full-resolution images");
    expect(readComparisonImage).toHaveBeenNthCalledWith(1, { path: "/photos/source.jpg" });
    expect(readComparisonImage).toHaveBeenNthCalledWith(2, { path: "/cache/output.webp" });
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
    expect(screen.getByText("100% scale · scroll either image to compare details")).toBeInTheDocument();

    const originalPane = screen.getByTestId("original-comparison-pane");
    const compressedPane = screen.getByTestId("compressed-comparison-pane");
    Object.defineProperty(originalPane, "scrollLeft", { value: 475, writable: true });
    Object.defineProperty(originalPane, "scrollTop", { value: 220, writable: true });
    fireEvent.scroll(originalPane);
    expect(compressedPane.scrollLeft).toBe(475);
    expect(compressedPane.scrollTop).toBe(220);
  });

  it("shows a useful error and retries both reads", async () => {
    readComparisonImage.mockRejectedValueOnce(new Error("File is no longer available"));
    render(<ImageComparison originalPath="source.jpg" compressedPath="output.webp" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("File is no longer available");
    readComparisonImage.mockResolvedValue({
      dataUrl: "data:image/png;base64,recovered",
      width: 800,
      height: 600,
    });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(readComparisonImage).toHaveBeenCalledTimes(4));
    expect(await screen.findByAltText("Compressed full-resolution preview")).toBeInTheDocument();
  });
});
