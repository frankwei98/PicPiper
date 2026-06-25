import { render, screen, fireEvent } from "@testing-library/react";
import { OptimizePage } from "./OptimizePage";

describe("OptimizePage", () => {
  it("shows per-image size feedback and lets quality change", () => {
    render(<OptimizePage />);

    expect(screen.getByText(/photo-01.jpg/)).toBeInTheDocument();
    expect(screen.getByText(/4.2 MB => 720 KB/)).toBeInTheDocument();

    const slider = screen.getByRole("slider", { name: /Quality 68%/ });
    fireEvent.change(slider, { target: { value: "50" } });

    expect(screen.getByText(/Quality 50%/)).toBeInTheDocument();
  });
});
