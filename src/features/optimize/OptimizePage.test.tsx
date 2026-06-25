import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OptimizePage } from "./OptimizePage";
import type { AppSettings } from "../../api/tauri";

const defaultSettings: AppSettings = {
  profiles: [],
  presets: [],
  namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
};

describe("OptimizePage", () => {
  it("shows per-image size feedback and lets quality change", () => {
    render(<OptimizePage settings={defaultSettings} />);

    expect(screen.getByText(/photo-01.jpg/)).toBeInTheDocument();
    expect(screen.getByText(/4.2 MB => 720 KB/)).toBeInTheDocument();

    const slider = screen.getByRole("slider", { name: /Quality 68%/ });
    fireEvent.change(slider, { target: { value: "50" } });

    expect(screen.getByText(/Quality 50%/)).toBeInTheDocument();
  });

  it("shows per-image size feedback and then compression result actions", async () => {
    const user = userEvent.setup();
    render(<OptimizePage settings={defaultSettings} />);

    expect(screen.getByText(/photo-01.jpg/)).toBeInTheDocument();
    expect(screen.getByText(/4.2 MB => 720 KB/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Compress" }));

    expect(screen.getByRole("heading", { name: "Compression results" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to local folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload to S3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to edit settings" })).toBeInTheDocument();
  });
});
