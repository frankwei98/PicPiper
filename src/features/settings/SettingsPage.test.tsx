import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

const { saveSettings, saveS3Secret } = vi.hoisted(() => ({
  saveSettings: vi.fn(async () => {}),
  saveS3Secret: vi.fn(async () => ({
    credentialRef: "s3:personal",
    insecureFallbackUsed: false,
  })),
}));

vi.mock("../../api/tauri", async () => ({
  settingsApi: {
    saveSettings,
    saveS3Secret,
  },
}));

import { SettingsPage } from "./SettingsPage";

describe("SettingsPage", () => {
  beforeEach(() => {
    saveSettings.mockClear();
    saveS3Secret.mockClear();
  });

  it("renders a save action for profile settings", () => {
    render(
      <SettingsPage
        settings={{
          profiles: [],
          presets: [],
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
        }}
        onSettingsChange={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /save profile/i })).toBeInTheDocument();
  });

  it("saves a profile and stores the secret through the credential API", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();

    render(
      <SettingsPage
        settings={{
          profiles: [],
          presets: [],
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
        }}
        onSettingsChange={onSettingsChange}
      />,
    );

    await user.clear(screen.getByLabelText("Profile name"));
    await user.type(screen.getByLabelText("Profile name"), "Personal R2");
    await user.type(screen.getByLabelText("Endpoint"), "https://example.r2.cloudflarestorage.com");
    await user.clear(screen.getByLabelText("Region"));
    await user.type(screen.getByLabelText("Region"), "auto");
    await user.type(screen.getByLabelText("Bucket"), "images");
    await user.type(screen.getByLabelText("Access key ID"), "access-key");
    await user.type(screen.getByLabelText("Secret access key"), "secret-key");
    await user.type(screen.getByLabelText("Public Base URL"), "https://cdn.example.com");
    await user.type(screen.getByLabelText("Default prefix"), "images/2026/06");

    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(saveS3Secret).toHaveBeenCalledWith({
      profileId: expect.any(String),
      secretAccessKey: "secret-key",
      allowInsecureFallback: false,
    });
    expect(saveSettings).toHaveBeenCalled();
    expect(onSettingsChange).toHaveBeenCalled();
  });
});
