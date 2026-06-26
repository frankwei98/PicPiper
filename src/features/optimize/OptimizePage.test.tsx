import { render, screen } from "@testing-library/react";
import { OptimizePage } from "./OptimizePage";
import { describe, it, expect } from "vitest";

describe("OptimizePage", () => {
  it("starts empty and asks the user to choose images", () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    expect(screen.getByText(/choose images/i)).toBeInTheDocument();
    expect(screen.queryByText("photo-01.jpg")).not.toBeInTheDocument();
    expect(screen.queryByText("/sample/photo-01.jpg")).not.toBeInTheDocument();
  });

  it("keeps Compress disabled until at least one image is inspected", () => {
    render(<OptimizePage namingTemplate="{yyyy}/{mm}/{slug}-{hash}.{ext}" />);

    expect(screen.getByRole("button", { name: "Compress" })).toBeDisabled();
  });
});
