import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

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
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
        }}
        onSettingsChange={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /save profile/i })).toBeInTheDocument();
  });

  it("does not render preset management", () => {
    render(
      <SettingsPage
        settings={{
          profiles: [],
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
        }}
        onSettingsChange={() => {}}
      />,
    );

    expect(screen.queryByText(/presets/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add preset/i })).not.toBeInTheDocument();
  });

  it("rejects saving a new profile when secret access key is empty", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();

    render(
      <SettingsPage
        settings={{
          profiles: [],
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
    // Secret access key intentionally left empty

    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(
      screen.getByText(/secret access key is required for a new profile/i),
    ).toBeInTheDocument();
    expect(saveS3Secret).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("saves a profile and stores the secret through the credential API", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();

    render(
      <SettingsPage
        settings={{
          profiles: [],
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

  it("shows profile selector when multiple profiles exist and allows editing the second profile", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    const profile1 = {
      id: "p1",
      name: "Personal S3",
      endpoint: "https://s3.example.com",
      region: "auto",
      bucket: "personal",
      accessKeyId: "key1",
      credentialRef: "s3:p1",
      pathStyle: true,
      defaultPrefix: "images",
      insecureSecretFallback: false,
    };
    const profile2 = {
      id: "p2",
      name: "Work S3",
      endpoint: "https://work.s3.example.com",
      region: "us-east-1",
      bucket: "work-bucket",
      accessKeyId: "key2",
      credentialRef: "s3:p2",
      pathStyle: true,
      defaultPrefix: "work/images",
      insecureSecretFallback: false,
    };

    render(
      <SettingsPage
        settings={{
          profiles: [profile1, profile2],
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
          defaultProfileId: "p1",
        }}
        onSettingsChange={onSettingsChange}
      />,
    );

    // Profile selector should be visible
    const select = screen.getByRole("combobox");
    expect(select).toBeInTheDocument();

    // Switch to second profile
    await user.selectOptions(select, "p2");

    // Form should show second profile's values
    expect(screen.getByLabelText("Profile name")).toHaveValue("Work S3");
    expect(screen.getByLabelText("Endpoint")).toHaveValue("https://work.s3.example.com");
    expect(screen.getByLabelText("Bucket")).toHaveValue("work-bucket");
  });

  it("preserves the existing credential when editing a profile without re-entering the secret", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();

    render(
      <SettingsPage
        settings={{
          profiles: [
            {
              id: "personal",
              name: "Personal R2",
              endpoint: "https://example.r2.cloudflarestorage.com",
              region: "auto",
              bucket: "images",
              accessKeyId: "access-key",
              credentialRef: "s3:personal",
              pathStyle: true,
              publicBaseUrl: "https://cdn.example.com",
              defaultPrefix: "images",
              insecureSecretFallback: false,
            },
          ],
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
        }}
        onSettingsChange={onSettingsChange}
      />,
    );

    await user.clear(screen.getByLabelText("Default prefix"));
    await user.type(screen.getByLabelText("Default prefix"), "images/2026/06");

    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(saveS3Secret).not.toHaveBeenCalled();
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        profiles: expect.arrayContaining([
          expect.objectContaining({
            id: "personal",
            credentialRef: "s3:personal",
            defaultPrefix: "images/2026/06",
          }),
        ]),
      }),
    );
    expect(onSettingsChange).toHaveBeenCalled();
  });
});
