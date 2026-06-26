import { render, screen } from "@testing-library/react";
import App from "./App";

describe("App", () => {
  it("renders the Pic Piper navigation", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Pic Piper" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Optimize/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /S3 Gallery/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Settings/ })).toBeInTheDocument();
  });
});
