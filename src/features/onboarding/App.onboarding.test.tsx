import { act, render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import App from "@/App";
import { settingsApi, type AppSettings } from "@/api/backend";

vi.mock("@/api/backend", () => ({ settingsApi: { loadSettings: vi.fn(), saveSettings: vi.fn() } }));
vi.mock("@/features/optimize/OptimizePage", () => ({ OptimizePage: () => <p>Compression workspace</p> }));
vi.mock("@/features/gallery/S3GalleryPage", () => ({ S3GalleryPage: () => <p>Storage workspace</p> }));
vi.mock("@/features/settings/SettingsPage", () => ({ SettingsPage: () => <p>Settings workspace</p> }));
const empty: AppSettings = { profiles: [], namingTemplate: "{slug}.{ext}" };
beforeEach(() => { vi.mocked(settingsApi.loadSettings).mockReset().mockResolvedValue(empty); vi.mocked(settingsApi.saveSettings).mockReset().mockResolvedValue(undefined); });

it("shows a skeleton while initial settings are loading", async () => {
  let resolve!: (value: AppSettings) => void;
  vi.mocked(settingsApi.loadSettings).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const { container } = render(<App />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading settings...");
  expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3);
  await act(async () => { resolve(empty); });
  expect(await screen.findByRole("heading", { name: "What would you like to use?" })).toBeVisible();
  expect(container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument();
});

it("persists completion so compression-only users do not see setup again", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Get started" }));
  expect(await screen.findByText("Compression workspace")).toBeVisible();
  const saved = vi.mocked(settingsApi.saveSettings).mock.calls[0][0];
  cleanup();
  vi.mocked(settingsApi.loadSettings).mockResolvedValue(saved);
  render(<App />);
  expect(await screen.findByText("Compression workspace")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "What would you like to use?" })).not.toBeInTheDocument();
});

it("opens storage after completing S3-only setup", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("checkbox", { name: /Compress/ }));
  await user.click(screen.getByRole("checkbox", { name: /S3 storage/ }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Configure S3 later" }));
  expect(await screen.findByText("Storage workspace")).toBeVisible();
});

it("does not prompt existing S3 users to repeat setup", async () => {
  vi.mocked(settingsApi.loadSettings).mockResolvedValue({ ...empty, profiles: [{ id: "existing", name: "Existing", endpoint: "https://s3.example.test", region: "auto", bucket: "images", accessKeyId: "fake", defaultPrefix: "", pathStyle: true }] });
  render(<App />);
  expect(await screen.findByText("Compression workspace")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "What would you like to use?" })).not.toBeInTheDocument();
});

it("blocks setup on a settings read failure and lets users retry", async () => {
  const user = userEvent.setup();
  vi.mocked(settingsApi.loadSettings).mockRejectedValueOnce(new Error("Unreadable settings"));
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Unreadable settings");
  expect(screen.queryByRole("button", { name: "Get started" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { name: "What would you like to use?" })).toBeVisible();
  expect(settingsApi.saveSettings).not.toHaveBeenCalled();
});

it("restores the storage workspace for returning S3-only users", async () => {
  vi.mocked(settingsApi.loadSettings).mockResolvedValue({ ...empty, onboardingCompleted: true, features: { compression: false, s3: true } });
  render(<App />);
  expect(await screen.findByText("Storage workspace")).toBeVisible();
});
