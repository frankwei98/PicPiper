import { render, screen } from "@testing-library/react";
import { S3GalleryPage } from "./S3GalleryPage";

const sampleProfile = {
  id: "p1",
  name: "Personal S3",
  bucket: "images",
  endpoint: "https://s3.example.com",
  region: "auto",
  accessKeyId: "AKIAEXAMPLE",
  pathStyle: false,
  defaultPrefix: "2026/06",
  publicBaseUrl: "https://cdn.example.com",
  insecureSecretFallback: false,
};

const defaultProps = {
  galleryFocus: { prefix: "", highlightedKeys: [] },
  profiles: [sampleProfile],
};

describe("S3GalleryPage", () => {
  it("does not render sample objects before a profile is selected and loaded", () => {
    render(<S3GalleryPage galleryFocus={{ prefix: "", highlightedKeys: [] }} profiles={[]} />);

    expect(screen.getByText(/no profile selected/i)).toBeInTheDocument();
    expect(screen.queryByText("2026/06/photo-01-abcdef12.webp")).not.toBeInTheDocument();
  });

  it("shows simplified manager actions without rename or move", () => {
    render(<S3GalleryPage {...defaultProps} />);

    expect(screen.getByRole("heading", { name: "S3 Gallery" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload local images" })).toBeInTheDocument();
    expect(screen.getByLabelText("Prefix")).toBeInTheDocument();
    expect(screen.queryByText(/rename/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/move/i)).not.toBeInTheDocument();
  });
});
