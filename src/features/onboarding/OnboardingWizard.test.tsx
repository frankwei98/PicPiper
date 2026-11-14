import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { OnboardingWizard } from "./OnboardingWizard";
import { settingsApi } from "@/api/backend";

vi.mock("@/api/backend", () => ({
  settingsApi: { saveSettings: vi.fn() },
  defaultMiniSettings: { enabled: false, targetFormat: "webp", quality: 90, action: "clipboard", profileId: "", linkFormat: "url" },
}));
const settings = { profiles: [], namingTemplate: "{slug}.{ext}" };
beforeEach(() => { vi.mocked(settingsApi.saveSettings).mockReset().mockResolvedValue(undefined); });

it("defaults to compression, opens Mini, and saves the Mini payload", async () => {
  const user = userEvent.setup();
  const complete = vi.fn();
  render(<OnboardingWizard settings={settings} onComplete={complete} />);
  expect(screen.getByRole("checkbox", { name: /Compress/ })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /S3 storage/ })).not.toBeChecked();
  expect(screen.queryByRole("switch", { name: "Enable Mini" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("heading", { name: "Mini" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Complete setup" }));
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ onboardingCompleted: true, features: { compression: true, s3: false }, mini: expect.objectContaining({ enabled: false }) }));
  expect(settingsApi.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ mini: expect.objectContaining({ enabled: false }) }));
});

it.each(["Cloudflare R2", "Other S3-compatible storage"])("defers %s configuration and then reaches Mini", async (provider) => {
  const user = userEvent.setup();
  const complete = vi.fn();
  render(<OnboardingWizard settings={settings} onComplete={complete} />);
  await user.click(screen.getByRole("checkbox", { name: /S3 storage/ }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("radio", { name: new RegExp(provider) }));
  if (provider === "Cloudflare R2") expect(screen.getByRole("button", { name: "Sign in with Cloudflare" })).toBeVisible();
  else expect(screen.getByRole("heading", { name: "Configure S3 later" })).toBeVisible();
  expect(screen.queryByLabelText("Secret access key")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: provider === "Cloudflare R2" ? "Configure S3 later" : "Continue" }));
  expect(screen.getByRole("heading", { name: "Mini" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Complete setup" }));
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ features: { compression: true, s3: true }, mini: expect.any(Object) }));
});

it("preserves selections when going back and prevents an empty feature selection", async () => {
  const user = userEvent.setup();
  render(<OnboardingWizard settings={settings} onComplete={vi.fn()} />);
  await user.click(screen.getByRole("checkbox", { name: /Compress/ }));
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /S3 storage/ }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("checkbox", { name: /Compress/ })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: /S3 storage/ })).toBeChecked();
});

it("allows Mini clipboard setup without an S3 profile", async () => {
  const user = userEvent.setup();
  const complete = vi.fn();
  render(<OnboardingWizard settings={settings} onComplete={complete} />);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("switch", { name: "Enable Mini" }));
  expect(screen.queryByRole("combobox", { name: "After compression" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("S3 profile")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Link format")).not.toBeInTheDocument();
  expect(screen.queryByText("Copies the image after compression. Upload to S3 anytime.")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Complete setup" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Complete setup" }));
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ mini: expect.objectContaining({ enabled: true, action: "clipboard" }) }));
  expect(settingsApi.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ mini: expect.objectContaining({ enabled: true, action: "clipboard" }) }));
});

it("keeps the wizard open on save failure and allows retry", async () => {
  const user = userEvent.setup();
  const complete = vi.fn();
  vi.mocked(settingsApi.saveSettings).mockRejectedValueOnce(new Error("Disk unavailable"));
  render(<OnboardingWizard settings={settings} onComplete={complete} />);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Complete setup" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Disk unavailable");
  expect(complete).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Complete setup" }));
  expect(complete).toHaveBeenCalledOnce();
});
