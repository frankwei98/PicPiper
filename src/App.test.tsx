import { fireEvent, render, screen } from "@testing-library/react";
import App from "./App";

describe("App", () => {
  it("renders the app views as tabs without a brand lockup", () => {
    render(<App />);

    expect(screen.queryByText("Pic Piper")).not.toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Views" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Optimize/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /S3 Gallery/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Settings/ })).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "app-tab-optimize");
  });

  it("switches views with tab keyboard navigation", () => {
    render(<App />);

    const optimizeTab = screen.getByRole("tab", { name: /Optimize/ });
    fireEvent.keyDown(optimizeTab, { key: "ArrowRight" });

    const galleryTab = screen.getByRole("tab", { name: /S3 Gallery/ });
    expect(galleryTab).toHaveFocus();
    expect(galleryTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "app-tab-gallery");
  });
});
