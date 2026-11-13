import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { AppSettings } from "./api/backend";
import type { S3Profile } from "./types";
import type { GalleryFocus } from "./state/appState";
import App from "./App";

const { settings } = vi.hoisted(() => ({ settings: {
  profiles: ["a", "b"].map((id) => ({ id, name: id, endpoint: "https://example.com", region: "auto",
    bucket: id, accessKeyId: "fake", defaultPrefix: "images", pathStyle: true })),
  defaultProfileId: "a", namingTemplate: "{slug}.{ext}",
} }));
vi.mock("@/platform/desktop", () => ({ open: vi.fn(), openUrl: vi.fn(), writeClipboard: vi.fn(), onFileDrop: vi.fn(() => vi.fn()), onImagesOpened: vi.fn(() => vi.fn()) }));
vi.mock("./api/backend", () => ({ settingsApi: { loadSettings: vi.fn(async () => settings) } }));
vi.mock("./features/optimize/OptimizePage", () => ({ OptimizePage: ({ activeProfile, onUploadedToS3 }: {
  activeProfile?: S3Profile; onUploadedToS3: (focus: GalleryFocus) => void;
}) => <button onClick={() => onUploadedToS3({ profileId: "a", prefix: "images", highlightedKeys: ["image"] })}>Target {activeProfile?.id}</button> }));
vi.mock("./features/settings/SettingsPage", () => ({ SettingsPage: ({ settings: current, onSettingsChange }: {
  settings: AppSettings; onSettingsChange: (settings: AppSettings) => void;
}) => <button onClick={() => onSettingsChange({ ...current, defaultProfileId: "b" })}>Use B as default</button> }));

it("does not let a previous upload's gallery focus override a newly selected default", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Target a" }));
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Use B as default" }));
  await user.click(screen.getByRole("tab", { name: "Compress" }));
  expect(screen.getByRole("button", { name: "Target b" })).toBeVisible();
});
