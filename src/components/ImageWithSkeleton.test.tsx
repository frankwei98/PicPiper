import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ImageWithSkeleton } from "./ImageWithSkeleton";

it("keeps a skeleton until the browser loads the image, including when its source changes", () => {
  const { container, rerender } = render(<ImageWithSkeleton src="first.png" alt="preview" />);
  expect(screen.getByRole("status")).toHaveAttribute("data-slot", "skeleton");
  fireEvent.load(screen.getByRole("img"));
  expect(container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument();
  rerender(<ImageWithSkeleton src="second.png" alt="preview" />);
  expect(screen.getByRole("status")).toHaveAttribute("data-slot", "skeleton");
  fireEvent.load(screen.getByRole("img"));
  expect(container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument();
});

it("replaces a failed browser decode with an error instead of an endless skeleton", () => {
  const { container } = render(<ImageWithSkeleton src="broken.png" alt="preview" />);
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByRole("status")).toHaveTextContent("The image could not be decoded.");
  expect(container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument();
});
