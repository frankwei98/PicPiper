import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { r2Api } from "@/api/backend";

vi.mock("@/api/backend", () => ({
  defaultMiniSettings: { enabled: false, targetFormat: "webp", quality: 90, action: "clipboard", profileId: "", linkFormat: "url" },
  settingsApi: {},
  r2Api: {
    start: vi.fn(async () => ({ sessionId: "test-session", authorizationUrl: "https://example.com/oauth" })),
    poll: vi.fn(async () => ({ status: "pending", message: "" })),
    cancel: vi.fn(async () => {}),
  },
}));
vi.mock("@/platform/desktop", () => ({ openUrl: vi.fn(async () => {}) }));

it("cancels browser authorization when leaving Settings and allows another attempt on return", async () => {
  const user = userEvent.setup();
  const settings = { profiles: [], namingTemplate: "{slug}.{ext}" };
  const onSettingsChange = vi.fn();
  const view = render(<SettingsPage settings={settings} onSettingsChange={onSettingsChange} isActive />);
  await user.click(screen.getByRole("tab", { name: "S3 profiles" }));
  await user.click(screen.getByRole("button", { name: "Add with an account" }));
  await user.click(screen.getByRole("button", { name: "Sign in with Cloudflare" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Waiting for browser authorization");
  view.rerender(<SettingsPage settings={settings} onSettingsChange={onSettingsChange} isActive={false} />);
  await waitFor(() => expect(r2Api.cancel).toHaveBeenCalledWith("test-session"));
  view.rerender(<SettingsPage settings={settings} onSettingsChange={onSettingsChange} isActive />);
  expect(screen.getByRole("button", { name: "Sign in with Cloudflare" })).toBeEnabled();
  expect(onSettingsChange).not.toHaveBeenCalled();
});
