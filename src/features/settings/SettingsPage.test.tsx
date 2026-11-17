import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type Dispatch, type SetStateAction } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppSettings } from "../../api/backend";

const { saveSettings, saveGeneralSettings, saveStorageSettings, loadSettings, saveS3Secret, testS3Connection, deleteProfile } = vi.hoisted(() => ({
  saveSettings: vi.fn(async (_settings?: AppSettings) => {}),
  saveGeneralSettings: vi.fn(),
  saveStorageSettings: vi.fn(),
  loadSettings: vi.fn(),
  saveS3Secret: vi.fn(async () => ({
    credentialRef: "s3:personal",
  })),
  testS3Connection: vi.fn(async () => {}),
  deleteProfile: vi.fn(async (_profileId: string): Promise<AppSettings> => ({ profiles: [], namingTemplate: "{slug}.{ext}" })),
}));

vi.mock("../../api/backend", async () => ({
  settingsApi: {
    saveSettings,
    saveGeneralSettings,
    saveStorageSettings,
    loadSettings,
    saveS3Secret,
    testS3Connection,
    deleteProfile,
  },
  defaultMiniSettings: { enabled: false, targetFormat: "webp", quality: 90, action: "clipboard", profileId: "", linkFormat: "url" },
}));

import { SettingsPage } from "./SettingsPage";

async function goToSection(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("tab", { name }));
}

describe("SettingsPage", () => {
  beforeEach(() => {
    saveSettings.mockReset();
    saveSettings.mockResolvedValue(undefined);
    saveGeneralSettings.mockReset();
    saveGeneralSettings.mockImplementation(async (settings: AppSettings) => { await saveSettings(settings); return settings; });
    saveStorageSettings.mockReset();
    saveStorageSettings.mockImplementation(async (settings: AppSettings) => { await saveSettings(settings); return settings; });
    loadSettings.mockReset();
    loadSettings.mockImplementation(async () => saveSettings.mock.calls[saveSettings.mock.calls.length - 1]?.[0]);
    saveS3Secret.mockReset();
    saveS3Secret.mockResolvedValue({ credentialRef: "s3:personal" });
    testS3Connection.mockReset();
    testS3Connection.mockResolvedValue(undefined);
    deleteProfile.mockReset();
    deleteProfile.mockResolvedValue({ profiles: [], namingTemplate: "{slug}.{ext}" });
  });

  it("starts on General and renders its save action", () => {
    render(<SettingsPage settings={{ profiles: [], namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}" }} onSettingsChange={() => {}} />);

    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Save general settings" })).toBeInTheDocument();
  });

  it("keeps a Mini change made while a profile credential save is awaiting failure", async () => {
    const user = userEvent.setup();
    let stored: AppSettings = {
      profiles: [{ id: "profile", name: "Profile", endpoint: "https://s3.example.test", region: "auto", bucket: "images", accessKeyId: "fake-access", credentialRef: "s3:profile", defaultPrefix: "", pathStyle: true }],
      namingTemplate: "{slug}.{ext}",
      mini: { enabled: true, targetFormat: "webp", quality: 90, action: "clipboard", profileId: "", linkFormat: "url" },
    };
    saveSettings.mockImplementation(async (settings) => { stored = settings!; });
    saveStorageSettings.mockImplementation(async (settings: AppSettings) => {
      stored = { ...stored, profiles: settings.profiles, namingTemplate: settings.namingTemplate, defaultProfileId: settings.defaultProfileId };
      return stored;
    });
    loadSettings.mockImplementation(async () => stored);
    let rejectSecret: ((error: Error) => void) | undefined;
    saveS3Secret.mockImplementationOnce(() => new Promise((_, reject) => { rejectSecret = reject; }));
    const view = render(<SettingsPage settings={stored} onSettingsChange={() => {}} />);
    await goToSection(user, "S3 profiles");
    await user.type(screen.getByLabelText("Secret access key"), "fake-new-secret");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(saveS3Secret).toHaveBeenCalled());
    stored = { ...stored, mini: { ...stored.mini!, targetFormat: "avif", quality: 77 } };
    view.rerender(<SettingsPage settings={stored} onSettingsChange={() => {}} />);
    await act(async () => rejectSecret?.(new Error("credential write failed")));
    await screen.findByText("credential write failed");
    expect(stored.mini).toMatchObject({ targetFormat: "avif", quality: 77 });
  });

  it("shows the settings groups and expected tab order without a Mini tab", () => {
    render(<SettingsPage settings={{ profiles: [], namingTemplate: "{slug}.{ext}" }} onSettingsChange={() => {}} />);

    expect(screen.getByText("Application")).toBeVisible();
    expect(screen.getByText("Cloud storage")).toBeVisible();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent?.trim())).toEqual([
      "General", "S3 profiles", "One-click authorization", "Links and naming",
    ]);
    expect(screen.queryByRole("tab", { name: "Mini" })).not.toBeInTheDocument();
  });

  it("saves status bar settings while preserving the rest of the app settings", async () => {
    const user = userEvent.setup();
    const settings = { profiles: [], namingTemplate: "{slug}.{ext}", defaultOutputDir: "/tmp/out", features: { compression: true, s3: false } };
    const onSettingsChange = vi.fn();
    render(<SettingsPage settings={settings} onSettingsChange={onSettingsChange} />);
    await user.click(screen.getByRole("switch", { name: "Show status bar icon" }));
    await user.click(screen.getByRole("button", { name: "Save general settings" }));
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ ...settings, closeBehavior: "quit", mini: expect.objectContaining({ enabled: true, action: "clipboard" }) }));
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ ...settings, closeBehavior: "quit", mini: expect.objectContaining({ enabled: true, action: "clipboard" }) }));
    expect(await screen.findByRole("status")).toHaveTextContent("General settings saved.");
  });

  it("saves general settings without requiring an S3 profile", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(<SettingsPage settings={{ profiles: [], namingTemplate: "{slug}.{ext}" }} onSettingsChange={onSettingsChange} />);
    await user.click(screen.getByRole("switch", { name: "Show status bar icon" }));
    expect(screen.queryByRole("combobox", { name: "After compression" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("S3 profile")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Link format")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save general settings" }));
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ closeBehavior: "quit", mini: expect.objectContaining({ enabled: true, action: "clipboard" }) }));
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ closeBehavior: "quit", mini: expect.objectContaining({ enabled: true, action: "clipboard" }) }));
  });

  it("shows general settings save errors and does not publish unsaved settings", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    saveSettings.mockRejectedValueOnce(new Error("Disk unavailable"));
    render(<SettingsPage settings={{ profiles: [], namingTemplate: "{slug}.{ext}" }} onSettingsChange={onSettingsChange} />);
    await user.click(screen.getByRole("switch", { name: "Show status bar icon" }));
    await user.click(screen.getByRole("button", { name: "Save general settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk unavailable");
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("keeps drafts while moving between settings categories", async () => {
    const user = userEvent.setup();
    render(<SettingsPage settings={{ profiles: [], namingTemplate: "{slug}.{ext}" }} onSettingsChange={() => {}} />);

    await goToSection(user, "S3 profiles");
    await user.clear(screen.getByLabelText("Profile name"));
    await user.type(screen.getByLabelText("Profile name"), "Draft profile");
    await goToSection(user, "General");
    await goToSection(user, "Links and naming");
    await user.type(screen.getByLabelText("Default prefix"), "draft/images");
    await goToSection(user, "S3 profiles");

    expect(screen.getByLabelText("Profile name")).toHaveValue("Draft profile");
    await goToSection(user, "Links and naming");
    expect(screen.getByLabelText("Default prefix")).toHaveValue("draft/images");
  });

  it("opens account authorization from the S3 hero and hides S3 fields", async () => {
    const user = userEvent.setup();
    render(<SettingsPage settings={{ profiles: [], namingTemplate: "{slug}.{ext}" }} onSettingsChange={() => {}} />);

    await goToSection(user, "S3 profiles");
    await user.click(screen.getByRole("button", { name: "Add with an account" }));

    expect(screen.getByRole("tab", { name: "One-click authorization" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "One-click authorization" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Profile name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Endpoint" })).not.toBeInTheDocument();
  });

  it("shows provider-neutral one-click authorization with the Cloudflare R2 provider", async () => {
    const user = userEvent.setup();
    render(<SettingsPage settings={{ profiles: [], namingTemplate: "{slug}.{ext}" }} onSettingsChange={() => {}} />);

    await goToSection(user, "One-click authorization");

    expect(screen.getByRole("tabpanel", { name: "One-click authorization" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Cloudflare R2" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign in with Cloudflare" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: /Cloudflare authorization/i })).not.toBeInTheDocument();
  });

  it("does not render preset management", async () => {
    const user = userEvent.setup();
    render(<SettingsPage settings={{ profiles: [], namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}" }} onSettingsChange={() => {}} />);
    await goToSection(user, "Links and naming");

    expect(screen.queryByText(/presets/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add preset/i })).not.toBeInTheDocument();
  });

  it("requires confirmation before deleting a profile and its local credentials", async () => {
    const user = userEvent.setup();
    const existing = { id: "personal", name: "Personal R2", endpoint: "https://s3.example.com", region: "auto", bucket: "images", accessKeyId: "key", credentialRef: "s3:personal", pathStyle: true, defaultPrefix: "images" };
    render(<SettingsPage settings={{ profiles: [existing], namingTemplate: "{slug}.{ext}" }} onSettingsChange={() => {}} />);
    await goToSection(user, "S3 profiles");

    await user.click(screen.getByRole("button", { name: "Delete profile" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Personal R2");
    expect(dialog).toHaveTextContent("saved credentials from this device");
    expect(dialog).toHaveTextContent("Objects in this bucket will remain in S3.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(deleteProfile).not.toHaveBeenCalled();
  });

  it("applies returned settings after deletion and selects a remaining profile", async () => {
    const user = userEvent.setup();
    const first = { id: "first", name: "Personal R2", endpoint: "https://s3.example.com", region: "auto", bucket: "images", accessKeyId: "key", credentialRef: "s3:first", pathStyle: true, defaultPrefix: "images" };
    const second = { id: "second", name: "Work S3", endpoint: "https://s3.example.com", region: "auto", bucket: "work", accessKeyId: "work-key", credentialRef: "s3:second", pathStyle: true, defaultPrefix: "work" };
    const nextSettings: AppSettings = { profiles: [second], namingTemplate: "{slug}.{ext}" };
    deleteProfile.mockResolvedValueOnce(nextSettings);
    const onSettingsChange = vi.fn();
    render(<SettingsPage settings={{ profiles: [first, second], namingTemplate: "{slug}.{ext}", defaultProfileId: "first" }} onSettingsChange={onSettingsChange} />);
    await goToSection(user, "S3 profiles");
    await user.click(screen.getByRole("button", { name: "Delete profile" }));
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete profile" }));

    expect(deleteProfile).toHaveBeenCalledWith("first");
    expect(onSettingsChange).toHaveBeenCalledWith(nextSettings);
    expect(screen.getByLabelText("Profile name")).toHaveValue("Work S3");
    expect(await screen.findByText("Profile deleted.")).toBeInTheDocument();
  });

  it("keeps profile deletion, connection tests, and saving mutually exclusive", async () => {
    const user = userEvent.setup();
    const existing = { id: "personal", name: "Personal R2", endpoint: "https://s3.example.com", region: "auto", bucket: "images", accessKeyId: "key", credentialRef: "s3:personal", pathStyle: true, defaultPrefix: "images" };
    let resolveTest!: () => void;
    testS3Connection.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveTest = resolve; }));
    render(<SettingsPage settings={{ profiles: [existing], namingTemplate: "{slug}.{ext}" }} onSettingsChange={() => {}} />);
    await goToSection(user, "S3 profiles");

    const deleteButton = screen.getByRole("button", { name: "Delete profile" });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(deleteButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
    resolveTest();
    await screen.findByText("Connection successful. Bucket listing works.");

    await user.click(deleteButton);
    const dialog = screen.getByRole("alertdialog");
    let resolveDelete!: (settings: AppSettings) => void;
    deleteProfile.mockImplementationOnce(() => new Promise<AppSettings>((resolve) => { resolveDelete = resolve; }));
    await user.click(within(dialog).getByRole("button", { name: "Delete profile" }));
    const buttons = Array.from(document.querySelectorAll("button"));
    expect(buttons.find((button) => button.textContent?.trim() === "Test connection")).toBeDisabled();
    expect(buttons.find((button) => button.textContent?.trim() === "Save profile")).toBeDisabled();
    resolveDelete({ profiles: [], namingTemplate: "{slug}.{ext}" });
    await screen.findByText("Profile deleted.");
  });

  it("enters new-profile mode after deleting the last profile and reports failures", async () => {
    const user = userEvent.setup();
    const existing = { id: "personal", name: "Personal R2", endpoint: "https://s3.example.com", region: "auto", bucket: "images", accessKeyId: "key", credentialRef: "s3:personal", pathStyle: true, defaultPrefix: "images" };
    const onSettingsChange = vi.fn();
    render(<SettingsPage settings={{ profiles: [existing], namingTemplate: "{slug}.{ext}" }} onSettingsChange={onSettingsChange} />);
    await goToSection(user, "S3 profiles");
    deleteProfile.mockRejectedValueOnce(new Error("Credential file could not be removed"));
    await user.click(screen.getByRole("button", { name: "Delete profile" }));
    let dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete profile" }));
    expect(await screen.findByText("Credential file could not be removed")).toBeInTheDocument();
    expect(onSettingsChange).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    deleteProfile.mockResolvedValueOnce({ profiles: [], namingTemplate: "{slug}.{ext}" });
    await user.click(screen.getByRole("button", { name: "Delete profile" }));
    dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete profile" }));
    expect(screen.getByLabelText("Profile name")).toHaveValue("");
    expect(onSettingsChange).toHaveBeenCalledWith({ profiles: [], namingTemplate: "{slug}.{ext}" });
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

    await goToSection(user, "S3 profiles");
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

    await goToSection(user, "S3 profiles");
    await user.clear(screen.getByLabelText("Profile name"));
    await user.type(screen.getByLabelText("Profile name"), "Personal R2");
    await user.type(screen.getByLabelText("Endpoint"), "https://example.r2.cloudflarestorage.com");
    await user.clear(screen.getByLabelText("Region"));
    await user.type(screen.getByLabelText("Region"), "auto");
    await user.type(screen.getByLabelText("Bucket"), "images");
    await user.type(screen.getByLabelText("Access key ID"), "access-key");
    await user.type(screen.getByLabelText("Secret access key"), "secret-key");
    await goToSection(user, "Links and naming");
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

  it("keeps a newly saved profile committed when reloading settings fails", async () => {
    const user = userEvent.setup();
    const initialSettings: AppSettings = {
      profiles: [],
      namingTemplate: "{slug}.{ext}",
      mini: { enabled: false, targetFormat: "webp", quality: 90, action: "clipboard", profileId: "", linkFormat: "url" },
    };
    const onSettingsChange = vi.fn();
    loadSettings.mockRejectedValueOnce(new Error("Settings reload unavailable"));
    let finishSecret: (() => void) | undefined;
    saveS3Secret.mockImplementationOnce(() => new Promise((resolve) => {
      finishSecret = () => resolve({ credentialRef: "s3:new-profile" });
    }));
    let setHarnessSettings: Dispatch<SetStateAction<AppSettings>> | undefined;
    function Harness() {
      const [settings, setSettings] = useState(initialSettings);
      setHarnessSettings = setSettings;
      return <SettingsPage settings={settings} onSettingsChange={(next) => { onSettingsChange(next); setSettings(next); }} />;
    }

    render(<Harness />);
    await goToSection(user, "S3 profiles");
    await user.click(screen.getByRole("button", { name: /add profile/i }));
    await user.clear(screen.getByLabelText("Profile name"));
    await user.type(screen.getByLabelText("Profile name"), "New S3");
    await user.type(screen.getByLabelText("Endpoint"), "https://new.s3.example.com");
    await user.clear(screen.getByLabelText("Region"));
    await user.type(screen.getByLabelText("Region"), "auto");
    await user.type(screen.getByLabelText("Bucket"), "new-bucket");
    await user.type(screen.getByLabelText("Access key ID"), "new-key");
    await user.type(screen.getByLabelText("Secret access key"), "new-secret");

    await user.click(screen.getByRole("button", { name: "Save profile" }));

    const savedProfileId = saveStorageSettings.mock.calls[0]![0]!.profiles[0]!.id;
    await waitFor(() => expect(saveS3Secret).toHaveBeenCalledTimes(1));
    act(() => setHarnessSettings?.((current) => ({
      ...current,
      mini: { ...current.mini!, targetFormat: "avif", quality: 77 },
    })));
    await act(async () => finishSecret?.());
    await waitFor(() => expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({
      profiles: [expect.objectContaining({ id: savedProfileId, name: "New S3" })],
      mini: expect.objectContaining({ targetFormat: "avif", quality: 77 }),
    })));
    expect(await screen.findByRole("status")).toHaveTextContent("Profile saved.");
    expect(await screen.findByText("Settings reload unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText("Secret access key")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(saveStorageSettings).toHaveBeenCalledTimes(2));
    expect(saveStorageSettings.mock.calls[1]![0]!.profiles[0]!.id).toBe(savedProfileId);
    expect(saveS3Secret).toHaveBeenCalledTimes(1);
    expect(saveS3Secret).toHaveBeenCalledWith({ profileId: savedProfileId, secretAccessKey: "new-secret" });
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

    await goToSection(user, "S3 profiles");
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

    await goToSection(user, "S3 profiles");
    await user.type(screen.getByLabelText("Secret access key"), "replacement-secret");
    await goToSection(user, "Links and naming");
    await user.clear(screen.getByLabelText("Default prefix"));
    await user.type(screen.getByLabelText("Default prefix"), "images/2026/06");

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

    await goToSection(user, "S3 profiles");
    await user.type(screen.getByLabelText("Profile name"), "Local MinIO");
    await user.type(screen.getByLabelText("Endpoint"), "http://localhost:9000");
    await user.type(screen.getByLabelText("Bucket"), "images");
    await user.type(screen.getByLabelText("Access key ID"), "local-key");
    await user.type(screen.getByLabelText("Secret access key"), "local-secret");
    await goToSection(user, "Links and naming");
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

    await goToSection(user, "S3 profiles");
    // Profile selector should be visible
    const select = screen.getByRole("combobox", { name: /editing profile/i });
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

    await goToSection(user, "S3 profiles");
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
    await goToSection(user, "S3 profiles");
    await user.selectOptions(screen.getByRole("combobox", { name: /editing profile/i }), "other");
    expect(screen.getByLabelText("Use as default profile")).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ defaultProfileId: "default" }));
  });

  it("shows field errors and focuses the first invalid field", async () => {
    const user = userEvent.setup();
    render(<SettingsPage settings={{ profiles: [], namingTemplate: "{slug}.{ext}" }} onSettingsChange={() => {}} />);
    await goToSection(user, "S3 profiles");

    await user.clear(screen.getByLabelText("Profile name"));
    await user.click(screen.getByRole("button", { name: /save profile/i }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: /profile name/i })).toHaveFocus());
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

    await goToSection(user, "S3 profiles");
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

    await goToSection(user, "S3 profiles");
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

  it("renders local credential storage copy", async () => {
    const user = userEvent.setup();
    render(
      <SettingsPage
        settings={{
          profiles: [],
          namingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}",
        }}
        onSettingsChange={() => {}}
      />,
    );

    await goToSection(user, "S3 profiles");
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

    await goToSection(user, "S3 profiles");
    await user.type(screen.getByLabelText("Profile name"), "Test");
    await user.type(screen.getByLabelText("Endpoint"), "https://s3.example.com");
    await user.type(screen.getByLabelText("Bucket"), "images");
    await user.type(screen.getByLabelText("Access key ID"), "key");
    await user.type(screen.getByLabelText("Secret access key"), "secret");
    await goToSection(user, "Links and naming");
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

    await goToSection(user, "S3 profiles");
    await user.type(screen.getByLabelText("Profile name"), "Test");
    await user.type(screen.getByLabelText("Endpoint"), "https://s3.example.com");
    await user.type(screen.getByLabelText("Bucket"), "images");
    await user.type(screen.getByLabelText("Access key ID"), "key");
    await user.type(screen.getByLabelText("Secret access key"), "secret");
    await goToSection(user, "Links and naming");
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

    await goToSection(user, "S3 profiles");
    await user.type(screen.getByLabelText("Profile name"), "Test");
    await user.type(screen.getByLabelText("Endpoint"), "https://s3.example.com");
    await user.type(screen.getByLabelText("Bucket"), "images");
    await user.type(screen.getByLabelText("Access key ID"), "key");
    await user.type(screen.getByLabelText("Secret access key"), "secret");
    await goToSection(user, "Links and naming");
    await user.type(screen.getByLabelText("Public Base URL"), "javascript:alert(1)");

    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(screen.getByText(/must use http: or https: protocol/i)).toBeInTheDocument();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("updates the naming template input when settings.namingTemplate arrives asynchronously", async () => {
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

    const user = userEvent.setup();
    await goToSection(user, "Links and naming");
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

    await goToSection(user, "Links and naming");
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

    await goToSection(user, "S3 profiles");
    expect(screen.getByLabelText("Profile name")).toHaveValue("Personal R2");
    expect(screen.getByLabelText("Endpoint")).toHaveValue(
      "https://example.r2.cloudflarestorage.com",
    );

    await goToSection(user, "Links and naming");
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

    await goToSection(user, "S3 profiles");
    await user.clear(screen.getByLabelText("Profile name"));
    await user.type(screen.getByLabelText("Profile name"), "Draft R2");
    await user.type(screen.getByLabelText("Endpoint"), "https://example.r2.cloudflarestorage.com");
    await user.type(screen.getByLabelText("Bucket"), "images");
    await user.type(screen.getByLabelText("Access key ID"), "draft-key");
    await user.type(screen.getByLabelText("Secret access key"), "unsaved-secret");
    await goToSection(user, "Links and naming");
    await user.type(screen.getByLabelText("Default prefix"), "draft/images");
    await goToSection(user, "S3 profiles");
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

    await goToSection(user, "S3 profiles");
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

    await goToSection(user, "S3 profiles");
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

    await goToSection(user, "S3 profiles");
    await user.click(screen.getByRole("button", { name: /test connection/i }));
    await user.clear(screen.getByLabelText("Endpoint"));
    await user.type(screen.getByLabelText("Endpoint"), "https://new.s3.example.com");
    resolveTest();

    await waitFor(() => expect(screen.getByRole("button", { name: /test connection/i })).toBeEnabled());
    expect(screen.queryByText(/connection successful/i)).not.toBeInTheDocument();
  });
});
