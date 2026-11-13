import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { OnboardingWizard } from "./OnboardingWizard";
import { settingsApi } from "@/api/backend";

vi.mock("@/api/backend", () => ({ settingsApi: { saveSettings: vi.fn() } }));
const settings = { profiles: [], namingTemplate: "{slug}.{ext}" };
beforeEach(() => { vi.mocked(settingsApi.saveSettings).mockReset().mockResolvedValue(undefined); });

it("defaults to compression and finishes without asking for credentials", async () => {
  const user = userEvent.setup();
  const complete = vi.fn();
  render(<OnboardingWizard settings={settings} onComplete={complete} />);
  expect(screen.getByRole("checkbox", { name: /Compress/ })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /S3 storage/ })).not.toBeChecked();
  await user.click(screen.getByRole("button", { name: "Get started" }));
  expect(complete).toHaveBeenCalledWith({ ...settings, onboardingCompleted: true, features: { compression: true, s3: false } });
});

it.each(["Cloudflare R2", "Other S3-compatible storage"])("defers %s configuration and completes setup", async (provider) => {
  const user = userEvent.setup();
  const complete = vi.fn();
  render(<OnboardingWizard settings={settings} onComplete={complete} />);
  await user.click(screen.getByRole("checkbox", { name: /S3 storage/ }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("radio", { name: new RegExp(provider) }));
  if (provider === "Cloudflare R2") expect(screen.getByRole("button", { name: "Sign in with Cloudflare" })).toBeVisible();
  else expect(screen.getByRole("heading", { name: "Configure S3 later" })).toBeVisible();
  expect(screen.queryByLabelText("Secret access key")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: provider === "Cloudflare R2" ? "Configure S3 later" : "Get started" }));
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ features: { compression: true, s3: true } }));
});

it("preserves selections when going back and prevents an empty selection", async () => {
  const user = userEvent.setup();
  render(<OnboardingWizard settings={settings} onComplete={vi.fn()} />);
  await user.click(screen.getByRole("checkbox", { name: /Compress/ }));
  expect(screen.getByRole("button", { name: "Get started" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /S3 storage/ }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("checkbox", { name: /Compress/ })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: /S3 storage/ })).toBeChecked();
});

it("keeps the wizard open on save failure and allows retry", async () => {
  const user = userEvent.setup();
  const complete = vi.fn();
  vi.mocked(settingsApi.saveSettings).mockRejectedValueOnce(new Error("Disk unavailable"));
  render(<OnboardingWizard settings={settings} onComplete={complete} />);
  await user.click(screen.getByRole("button", { name: "Get started" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Disk unavailable");
  expect(complete).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Get started" }));
  expect(complete).toHaveBeenCalledOnce();
});
