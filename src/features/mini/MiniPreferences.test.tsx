import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { defaultMiniSettings } from "@/api/backend";
import { MiniPreferences } from "./MiniPreferences";

it("starts disabled and reveals configuration when enabled", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<MiniPreferences value={defaultMiniSettings} onChange={onChange} profiles={[]} />);
  expect(screen.getByRole("switch", { name: "Enable Mini" })).not.toBeChecked();
  expect(screen.queryByLabelText("Image format")).not.toBeInTheDocument();
  await user.click(screen.getByRole("switch", { name: "Enable Mini" }));
  expect(onChange).toHaveBeenCalledWith({ ...defaultMiniSettings, enabled: true });
  render(<MiniPreferences value={{ ...defaultMiniSettings, enabled: true }} onChange={onChange} profiles={[]} />);
  expect(screen.getByLabelText("Image format")).toBeVisible();
  expect(screen.getByLabelText("Quality")).toHaveValue(90);
  expect(screen.queryByRole("combobox", { name: "After compression" })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Upload to S3" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("S3 profile")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Link format")).not.toBeInTheDocument();
  expect(screen.queryByText("Copies the image after compression. Upload to S3 anytime.")).not.toBeInTheDocument();
});

it("ignores the legacy automatic-upload mode in Mini preferences", () => {
  const onChange = vi.fn();
  render(<MiniPreferences value={{ ...defaultMiniSettings, enabled: true, action: "upload" }} onChange={onChange} profiles={[]} />);
  expect(screen.queryByRole("combobox", { name: "After compression" })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Upload to S3" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("S3 profile")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Link format")).not.toBeInTheDocument();
  expect(screen.queryByText("Compress and upload")).not.toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});
