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

  it("rejects saving a new profile when secret access key is empty", async () => {
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
          presets: [],
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

  it("adds a new preset and saves it via saveSettings", async () => {
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

    // Click "Add preset"
    await user.click(screen.getByRole("button", { name: /add preset/i }));

    // Fill out the preset form
    await user.type(screen.getByLabelText(/preset name/i), "Thumbnail");
    await user.selectOptions(screen.getByLabelText(/target format/i), "jpg");
    await user.clear(screen.getByLabelText(/quality/i));
    await user.type(screen.getByLabelText(/quality/i), "60");

    // Save the preset
    await user.click(screen.getByRole("button", { name: /save preset/i }));

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        presets: expect.arrayContaining([
          expect.objectContaining({
            name: "Thumbnail",
            targetFormat: "jpg",
            quality: 60,
          }),
        ]),
      }),
    );
    expect(onSettingsChange).toHaveBeenCalled();
  });

  it("edits an existing preset and updates it via saveSettings", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();

    render(
      <SettingsPage
        settings={{
          profiles: [],
          presets: [
            {
              id: "p1",
              name: "Small web",
              targetFormat: "webp",
              quality: 85,
              maxWidth: 1600,
              maxHeight: 1600,
              allowUpscale: false,
              removeGps: true,
            },
          ],
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
        }}
        onSettingsChange={onSettingsChange}
      />,
    );

    // Click "Edit" on the preset
    await user.click(screen.getByRole("button", { name: /edit/i }));

    // Change the name
    const nameInput = screen.getByLabelText(/preset name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Updated preset");

    // Update the preset
    await user.click(screen.getByRole("button", { name: /update preset/i }));

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        presets: expect.arrayContaining([
          expect.objectContaining({
            id: "p1",
            name: "Updated preset",
          }),
        ]),
      }),
    );
    expect(onSettingsChange).toHaveBeenCalled();
  });

  it("deletes a preset and saves via saveSettings", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();

    render(
      <SettingsPage
        settings={{
          profiles: [],
          presets: [
            {
              id: "p1",
              name: "To delete",
              targetFormat: "webp",
              quality: 85,
              maxWidth: 1600,
              maxHeight: 1600,
              allowUpscale: false,
              removeGps: true,
            },
          ],
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
        }}
        onSettingsChange={onSettingsChange}
      />,
    );

    // Click "Delete" on the preset
    await user.click(screen.getByRole("button", { name: /delete/i }));

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        presets: [],
      }),
    );
    expect(onSettingsChange).toHaveBeenCalled();
  });
});
