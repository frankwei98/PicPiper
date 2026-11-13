import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import App from "./App";

vi.mock("@/platform/desktop", () => ({ open: vi.fn(), openUrl: vi.fn(), writeClipboard: vi.fn(), onFileDrop: vi.fn(() => vi.fn()), onImagesOpened: vi.fn(() => vi.fn()) }));
vi.mock("./api/backend", () => ({
  settingsApi: { loadSettings: vi.fn(async () => ({ profiles: [], onboardingCompleted: true, namingTemplate: "{slug}.{ext}" })) },
  imageApi: {}, galleryApi: {}, uploadApi: {}, namingApi: {},
}));

describe("App", () => {
  it("renders the image workbench identity and app views", async () => {
    render(<App />);
    await screen.findByRole("tablist", { name: "Views" });

    expect(screen.getByText("Pic Piper")).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Views" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Compress", "S3 Gallery"]);
    expect(screen.getByRole("tab", { name: /Compress/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /S3 Gallery/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Local processing")).not.toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "app-tab-optimize");
  });

  it("switches views with tab keyboard navigation", async () => {
    render(<App />);
    await screen.findByRole("tablist", { name: "Views" });

    const compressTab = screen.getByRole("tab", { name: /Compress/ });
    fireEvent.keyDown(compressTab, { key: "ArrowRight" });

    const galleryTab = screen.getByRole("tab", { name: /S3 Gallery/ });
    expect(galleryTab).toHaveFocus();
    expect(galleryTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "app-tab-gallery");
  });
});
