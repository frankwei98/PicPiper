import { render, screen } from "@testing-library/react";
import { S3GalleryPage } from "./S3GalleryPage";

const defaultProps = {
  galleryFocus: { prefix: "", highlightedKeys: [] },
  profiles: [],
};

describe("S3GalleryPage", () => {
  it("shows simplified manager actions without rename or move", () => {
    render(<S3GalleryPage {...defaultProps} />);

    expect(screen.getByRole("heading", { name: "S3 Gallery" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload local images" })).toBeInTheDocument();
    expect(screen.getByLabelText("Prefix")).toBeInTheDocument();
    expect(screen.queryByText(/rename/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/move/i)).not.toBeInTheDocument();
  });
});
