import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppSettings } from "../../api/tauri";

const { saveSettings, saveS3Secret, testS3Connection } = vi.hoisted(() => ({
  saveSettings: vi.fn(async (_settings?: AppSettings) => {}),
  saveS3Secret: vi.fn(async () => ({
    credentialRef: "s3:personal",
  })),
  testS3Connection: vi.fn(async () => {}),
}));

vi.mock("../../api/tauri", async () => ({
  settingsApi: {
    saveSettings,
    saveS3Secret,
    testS3Connection,
  },
}));

import { SettingsPage } from "./SettingsPage";

describe("SettingsPage", () => {
  beforeEach(() => {
    saveSettings.mockReset();
    saveSettings.mockResolvedValue(undefined);
    saveS3Secret.mockReset();
    saveS3Secret.mockResolvedValue({ credentialRef: "s3:personal" });
    testS3Connection.mockReset();
    testS3Connection.mockResolvedValue(undefined);
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
    });
    expect(saveSettings).toHaveBeenCalled();
    expect(onSettingsChange).toHaveBeenCalled();
  });

  it("does not store a credential when saving the profile settings fails", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    saveSettings.mockRejectedValueOnce(new Error("Settings storage unavailable"));

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
    await user.type(screen.getByLabelText("Bucket"), "images");
    await user.type(screen.getByLabelText("Access key ID"), "access-key");
    await user.type(screen.getByLabelText("Secret access key"), "secret-key");

    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(await screen.findByText(/settings storage unavailable/i)).toBeInTheDocument();
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveS3Secret).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("restores the original settings when storing an updated credential fails", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    const settings: AppSettings = {
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
          defaultPrefix: "images",
        },
      ],
      namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
      defaultProfileId: "personal",
    };
    saveS3Secret.mockRejectedValueOnce(new Error("Credential storage unavailable"));

    render(<SettingsPage settings={settings} onSettingsChange={onSettingsChange} />);

    await user.clear(screen.getByLabelText("Default prefix"));
    await user.type(screen.getByLabelText("Default prefix"), "images/2026/06");
    await user.type(screen.getByLabelText("Secret access key"), "replacement-secret");

    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(await screen.findByText(/credential storage unavailable/i)).toBeInTheDocument();
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2));
    expect(saveSettings).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        profiles: expect.arrayContaining([
          expect.objectContaining({ defaultPrefix: "images/2026/06" }),
        ]),
      }),
    );
    expect(saveSettings).toHaveBeenNthCalledWith(2, settings);
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("accepts a trusted local HTTP public base URL", async () => {
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

    await user.type(screen.getByLabelText("Profile name"), "Local MinIO");
    await user.type(screen.getByLabelText("Endpoint"), "http://localhost:9000");
    await user.type(screen.getByLabelText("Bucket"), "images");
    await user.type(screen.getByLabelText("Access key ID"), "local-key");
    await user.type(screen.getByLabelText("Secret access key"), "local-secret");
    await user.type(screen.getByLabelText("Public Base URL"), "http://localhost:9000/images");

    await user.click(screen.getByRole("button", { name: /save profile/i }));

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

  it("preserves the default profile when saving a different profile", async () => {
    const user = userEvent.setup();
    const profiles = [
      { id: "default", name: "Default", endpoint: "https://s3.example.com", region: "auto", bucket: "one", accessKeyId: "key-one", credentialRef: "s3:default", pathStyle: true, defaultPrefix: "images" },
      { id: "other", name: "Other", endpoint: "https://s3.example.com", region: "auto", bucket: "two", accessKeyId: "key-two", credentialRef: "s3:other", pathStyle: true, defaultPrefix: "images" },
    ];

    render(<SettingsPage settings={{ profiles, namingTemplate: "{slug}.{ext}", defaultProfileId: "default" }} onSettingsChange={() => {}} />);
    await user.selectOptions(screen.getByRole("combobox"), "other");
    expect(screen.getByLabelText("Use as default profile")).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ defaultProfileId: "default" }));
  });

  it("shows field errors and focuses the first invalid field", async () => {
    const user = userEvent.setup();
    render(<SettingsPage settings={{ profiles: [], namingTemplate: "{slug}.{ext}" }} onSettingsChange={() => {}} />);

    await user.clear(screen.getByLabelText("Profile name"));
    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(screen.getByRole("textbox", { name: /profile name/i })).toHaveFocus();
    expect(screen.getByText("Profile name is required.")).toBeInTheDocument();
    expect(screen.getByText("Endpoint is required.")).toBeInTheDocument();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("renders and saves path style addressing checkbox", async () => {
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
              defaultPrefix: "images",
            },
          ],
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
        }}
        onSettingsChange={onSettingsChange}
      />,
    );

    const checkbox = screen.getByLabelText("Path style addressing");
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toBeChecked();

    // Toggle off
    await user.click(checkbox);

    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        profiles: expect.arrayContaining([
          expect.objectContaining({
            id: "personal",
            pathStyle: false,
          }),
        ]),
      }),
    );
  });

  it("adds a new profile without overwriting existing ones", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();

    render(
      <SettingsPage
        settings={{
          profiles: [
            {
              id: "existing",
              name: "Existing S3",
              endpoint: "https://s3.example.com",
              region: "auto",
              bucket: "existing-bucket",
              accessKeyId: "key1",
              credentialRef: "s3:existing",
              pathStyle: true,
              defaultPrefix: "images",
            },
          ],
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
          defaultProfileId: "existing",
        }}
        onSettingsChange={onSettingsChange}
      />,
    );

    // Click Add profile
    await user.click(screen.getByRole("button", { name: /add profile/i }));

    // Fill in new profile
    await user.clear(screen.getByLabelText("Profile name"));
    await user.type(screen.getByLabelText("Profile name"), "New S3");
    await user.type(screen.getByLabelText("Endpoint"), "https://new.s3.example.com");
    await user.clear(screen.getByLabelText("Region"));
    await user.type(screen.getByLabelText("Region"), "auto");
    await user.type(screen.getByLabelText("Bucket"), "new-bucket");
    await user.type(screen.getByLabelText("Access key ID"), "new-key");
    await user.type(screen.getByLabelText("Secret access key"), "new-secret");

    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(saveSettings).toHaveBeenCalled();
    const savedSettings = saveSettings.mock.calls[0]![0]!;
    // Both profiles should exist
    expect(savedSettings.profiles).toHaveLength(2);
    expect(savedSettings.profiles[0].id).toBe("existing");
    expect(savedSettings.profiles[0].name).toBe("Existing S3");
    expect(savedSettings.profiles[1].name).toBe("New S3");
    expect(savedSettings.profiles[1].id).not.toBe("existing");
  });

  it("renders local credential storage copy", () => {
    render(
      <SettingsPage
        settings={{
          profiles: [],
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
        }}
        onSettingsChange={() => {}}
      />,
    );

    expect(screen.getByText(/stored locally on this device/i)).toBeInTheDocument();
  });

  it("rejects Public Base URL with query string", async () => {
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

    await user.type(screen.getByLabelText("Profile name"), "Test");
    await user.type(screen.getByLabelText("Endpoint"), "https://s3.example.com");
    await user.type(screen.getByLabelText("Bucket"), "images");
    await user.type(screen.getByLabelText("Access key ID"), "key");
    await user.type(screen.getByLabelText("Secret access key"), "secret");
    await user.type(screen.getByLabelText("Public Base URL"), "https://cdn.example.com?v=1");

    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(screen.getByText(/must not contain query strings or fragments/i)).toBeInTheDocument();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("rejects Public Base URL with fragment", async () => {
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

    await user.type(screen.getByLabelText("Profile name"), "Test");
    await user.type(screen.getByLabelText("Endpoint"), "https://s3.example.com");
    await user.type(screen.getByLabelText("Bucket"), "images");
    await user.type(screen.getByLabelText("Access key ID"), "key");
    await user.type(screen.getByLabelText("Secret access key"), "secret");
    await user.type(screen.getByLabelText("Public Base URL"), "https://cdn.example.com#section");

    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(screen.getByText(/must not contain query strings or fragments/i)).toBeInTheDocument();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("rejects Public Base URL with javascript: protocol", async () => {
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

    await user.type(screen.getByLabelText("Profile name"), "Test");
    await user.type(screen.getByLabelText("Endpoint"), "https://s3.example.com");
    await user.type(screen.getByLabelText("Bucket"), "images");
    await user.type(screen.getByLabelText("Access key ID"), "key");
    await user.type(screen.getByLabelText("Secret access key"), "secret");
    await user.type(screen.getByLabelText("Public Base URL"), "javascript:alert(1)");

    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(screen.getByText(/must use http: or https: protocol/i)).toBeInTheDocument();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("updates the naming template input when settings.namingTemplate arrives asynchronously", () => {
    // App.tsx loads settings after mount. First render receives default naming
    // template; real settings arrive on rerender.
    const { rerender } = render(
      <SettingsPage
        settings={{
          profiles: [],
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
        }}
        onSettingsChange={() => {}}
      />,
    );

    expect(screen.getByLabelText("Naming template")).toHaveValue(
      "{yyyy}/{mm}/{slug}-{hash}.{ext}",
    );

    rerender(
      <SettingsPage
        settings={{
          profiles: [],
          namingTemplate: "{slug}-{hash}.{ext}",
        }}
        onSettingsChange={() => {}}
      />,
    );

    expect(screen.getByLabelText("Naming template")).toHaveValue("{slug}-{hash}.{ext}");
  });

  it("edits and saves the default profile after settings arrive asynchronously", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    const loadedProfile = {
      id: "personal",
      name: "Personal R2",
      endpoint: "https://example.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "images",
      accessKeyId: "access-key",
      credentialRef: "s3:personal",
      pathStyle: true,
      defaultPrefix: "images",
    };
    const { rerender } = render(
      <SettingsPage
        settings={{
          profiles: [],
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
        }}
        onSettingsChange={onSettingsChange}
      />,
    );

    rerender(
      <SettingsPage
        settings={{
          profiles: [loadedProfile],
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
          defaultProfileId: loadedProfile.id,
        }}
        onSettingsChange={onSettingsChange}
      />,
    );

    expect(screen.getByLabelText("Profile name")).toHaveValue("Personal R2");
    expect(screen.getByLabelText("Endpoint")).toHaveValue(
      "https://example.r2.cloudflarestorage.com",
    );

    await user.clear(screen.getByLabelText("Default prefix"));
    await user.type(screen.getByLabelText("Default prefix"), "images/2026/07");
    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(saveS3Secret).not.toHaveBeenCalled();
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        profiles: [
          expect.objectContaining({
            id: "personal",
            defaultPrefix: "images/2026/07",
            credentialRef: "s3:personal",
          }),
        ],
        defaultProfileId: "personal",
      }),
    );
    expect(onSettingsChange).toHaveBeenCalled();
  });

  it("tests the current draft with an unsaved secret without saving it", async () => {
    const user = userEvent.setup();
    render(
      <SettingsPage
        settings={{ profiles: [], namingTemplate: "{slug}.{ext}" }}
        onSettingsChange={() => {}}
      />,
    );

    await user.clear(screen.getByLabelText("Profile name"));
    await user.type(screen.getByLabelText("Profile name"), "Draft R2");
    await user.type(screen.getByLabelText("Endpoint"), "https://example.r2.cloudflarestorage.com");
    await user.type(screen.getByLabelText("Bucket"), "images");
    await user.type(screen.getByLabelText("Access key ID"), "draft-key");
    await user.type(screen.getByLabelText("Secret access key"), "unsaved-secret");
    await user.type(screen.getByLabelText("Default prefix"), "draft/images");
    await user.click(screen.getByRole("button", { name: /test connection/i }));

    expect(testS3Connection).toHaveBeenCalledWith({
      profile: expect.objectContaining({
        name: "Draft R2",
        endpoint: "https://example.r2.cloudflarestorage.com",
        bucket: "images",
        accessKeyId: "draft-key",
        defaultPrefix: "draft/images",
      }),
      secretAccessKey: "unsaved-secret",
    });
    expect(await screen.findByText(/connection successful/i)).toBeInTheDocument();
    expect(saveSettings).not.toHaveBeenCalled();
    expect(saveS3Secret).not.toHaveBeenCalled();
  });

  it("tests an existing profile using its stored secret fallback", async () => {
    const user = userEvent.setup();
    const existing = {
      id: "personal",
      name: "Personal R2",
      endpoint: "https://example.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "images",
      accessKeyId: "stored-key",
      credentialRef: "s3:personal",
      pathStyle: true,
      defaultPrefix: "images",
    };
    render(
      <SettingsPage
        settings={{ profiles: [existing], namingTemplate: "{slug}.{ext}" }}
        onSettingsChange={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /test connection/i }));

    expect(testS3Connection).toHaveBeenCalledWith({ profile: existing });
    expect(saveSettings).not.toHaveBeenCalled();
    expect(saveS3Secret).not.toHaveBeenCalled();
  });

  it("shows a connection failure without saving the draft", async () => {
    const user = userEvent.setup();
    testS3Connection.mockRejectedValueOnce(new Error("Access denied"));
    const existing = {
      id: "personal", name: "Personal R2", endpoint: "https://s3.example.com",
      region: "auto", bucket: "images", accessKeyId: "key", credentialRef: "s3:personal",
      pathStyle: true, defaultPrefix: "images",
    };
    render(<SettingsPage settings={{ profiles: [existing], namingTemplate: "{slug}.{ext}" }} onSettingsChange={() => {}} />);

    await user.click(screen.getByRole("button", { name: /test connection/i }));

    expect(await screen.findByText("Access denied")).toBeInTheDocument();
    expect(saveSettings).not.toHaveBeenCalled();
    expect(saveS3Secret).not.toHaveBeenCalled();
  });

  it("ignores a connection result after the draft changes", async () => {
    const user = userEvent.setup();
    let resolveTest!: () => void;
    testS3Connection.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveTest = resolve; }));
    const existing = {
      id: "personal", name: "Personal R2", endpoint: "https://s3.example.com",
      region: "auto", bucket: "images", accessKeyId: "key", credentialRef: "s3:personal",
      pathStyle: true, defaultPrefix: "images",
    };
    render(<SettingsPage settings={{ profiles: [existing], namingTemplate: "{slug}.{ext}" }} onSettingsChange={() => {}} />);

    await user.click(screen.getByRole("button", { name: /test connection/i }));
    await user.clear(screen.getByLabelText("Endpoint"));
    await user.type(screen.getByLabelText("Endpoint"), "https://new.s3.example.com");
    resolveTest();

    await waitFor(() => expect(screen.getByRole("button", { name: /test connection/i })).toBeEnabled());
    expect(screen.queryByText(/connection successful/i)).not.toBeInTheDocument();
  });
});
