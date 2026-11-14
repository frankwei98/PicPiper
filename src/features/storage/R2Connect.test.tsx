import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { r2Api } from "@/api/backend";
import { openUrl } from "@/platform/desktop";
import { R2Connect } from "./R2Connect";

vi.mock("@/api/backend", () => ({ r2Api: { start: vi.fn(), poll: vi.fn(), cancel: vi.fn(), accounts: vi.fn(), buckets: vi.fn(), connect: vi.fn() } }));
vi.mock("@/platform/desktop", () => ({ openUrl: vi.fn() }));
const accountId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const saved = { profiles: [], namingTemplate: "{slug}.{ext}" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(r2Api.start).mockResolvedValue({ sessionId: "session", authorizationUrl: "https://dash.cloudflare.com/oauth2/auth?state=fake" });
  vi.mocked(openUrl).mockResolvedValue(undefined);
  vi.mocked(r2Api.poll).mockResolvedValue({ status: "authorized", message: "" });
  vi.mocked(r2Api.cancel).mockResolvedValue(undefined);
  vi.mocked(r2Api.accounts).mockResolvedValue([{ id: accountId, name: "Personal" }]);
  vi.mocked(r2Api.buckets).mockResolvedValue([{ name: "photos", jurisdiction: "default" }, { name: "screenshots", jurisdiction: "default" }]);
  vi.mocked(r2Api.connect).mockResolvedValue(saved);
});
async function signedIn() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Sign in with Cloudflare" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Load buckets" })).toBeEnabled());
  return user;
}
it("opens the browser and imports only checked buckets", async () => {
  const connected = vi.fn();
  render(<R2Connect onConnected={connected} />);
  const user = await signedIn();
  expect(openUrl).toHaveBeenCalledWith("https://dash.cloudflare.com/oauth2/auth?state=fake");
  await user.click(screen.getByRole("button", { name: "Load buckets" }));
  await user.click(await screen.findByRole("checkbox", { name: "photos" }));
  await user.click(screen.getByRole("checkbox", { name: "screenshots" }));
  await user.click(screen.getByRole("button", { name: "Add selected buckets" }));
  expect(r2Api.connect).toHaveBeenCalledWith({ sessionId: "session", accountId, jurisdiction: "default", buckets: ["photos", "screenshots"] });
  expect(connected).toHaveBeenCalledWith(saved);
  expect(screen.getByRole("status")).toHaveTextContent("Added 2 R2 profile(s).");
});
it("shows skeletons only while account and bucket content is loading", async () => {
  let resolveAccounts!: (value: { id: string; name: string }[]) => void;
  vi.mocked(r2Api.accounts).mockImplementationOnce(() => new Promise((done) => { resolveAccounts = done; }));
  const view = render(<R2Connect onConnected={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Sign in with Cloudflare" }));
  await waitFor(() => expect(view.container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(1));
  expect(screen.getByText("Cloudflare account ID").closest(".preference-row")?.querySelector("[aria-busy]")).toHaveAttribute("aria-busy", "true");
  await act(async () => { resolveAccounts([{ id: accountId, name: "Personal" }]); });
  expect(view.container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument();

  let resolveBuckets!: (value: { name: string; jurisdiction: string }[]) => void;
  vi.mocked(r2Api.buckets).mockImplementationOnce(() => new Promise((done) => { resolveBuckets = done; }));
  await user.click(screen.getByRole("button", { name: "Load buckets" }));
  expect(view.container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3);
  expect(screen.getByRole("group", { name: "Choose buckets" })).toHaveAttribute("aria-busy", "true");
  await act(async () => { resolveBuckets([{ name: "photos", jurisdiction: "default" }]); });
  expect(await screen.findByRole("checkbox", { name: "photos" })).toBeVisible();
  expect(view.container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument();
});
it("permits manual account discovery when listing accounts is denied", async () => {
  vi.mocked(r2Api.accounts).mockRejectedValueOnce(new Error("Missing permission"));
  render(<R2Connect onConnected={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Sign in with Cloudflare" }));
  const input = await screen.findByRole("textbox", { name: "Cloudflare account ID" });
  await user.type(input, accountId);
  await user.click(screen.getByRole("button", { name: "Load buckets" }));
  expect(await screen.findByRole("checkbox", { name: "photos" })).toBeVisible();
});
it("invalidates selections when changing jurisdiction", async () => {
  render(<R2Connect onConnected={vi.fn()} />);
  const user = await signedIn();
  await user.click(screen.getByRole("button", { name: "Load buckets" }));
  await user.click(await screen.findByRole("checkbox", { name: "photos" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "R2 jurisdiction" }), "eu");
  expect(screen.getByRole("button", { name: "Add selected buckets" })).toBeDisabled();
  expect(screen.queryByRole("checkbox", { name: "photos" })).not.toBeInTheDocument();
});
it("keeps an API failure retryable without completing setup", async () => {
  const connected = vi.fn();
  vi.mocked(r2Api.connect).mockRejectedValueOnce(new Error("Permission denied"));
  render(<R2Connect onConnected={connected} />);
  const user = await signedIn();
  await user.click(screen.getByRole("button", { name: "Load buckets" }));
  await user.click(await screen.findByRole("checkbox", { name: "photos" }));
  await user.click(screen.getByRole("button", { name: "Add selected buckets" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
  expect(connected).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Add selected buckets" }));
  expect(connected).toHaveBeenCalledOnce();
});
it("cancels an in-flight browser session when unmounted", async () => {
  vi.mocked(r2Api.poll).mockResolvedValue({ status: "pending", message: "" });
  const user = userEvent.setup();
  const view = render(<R2Connect onConnected={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Sign in with Cloudflare" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Waiting for browser authorization...");
  expect(view.container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument();
  view.unmount();
  expect(r2Api.cancel).toHaveBeenCalledWith("session");
});
it("cancels a session created after unmount without opening the browser", async () => {
  let resolve!: (value: { sessionId: string; authorizationUrl: string }) => void;
  vi.mocked(r2Api.start).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const user = userEvent.setup();
  const view = render(<R2Connect onConnected={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Sign in with Cloudflare" }));
  view.unmount();
  await act(async () => { resolve({ sessionId: "late", authorizationUrl: "https://dash.cloudflare.com/oauth2/auth" }); });
  expect(r2Api.cancel).toHaveBeenCalledWith("late");
  expect(openUrl).not.toHaveBeenCalled();
});
it("shows authorization denial and allows another attempt", async () => {
  vi.mocked(r2Api.poll).mockResolvedValueOnce({ status: "failed", message: "Sign-in declined" });
  render(<R2Connect onConnected={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Sign in with Cloudflare" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in declined");
  expect(screen.getByRole("button", { name: "Sign in with Cloudflare" })).toBeEnabled();
});

it("saves an independent public URL for each selected bucket with HTTPS prefilled", async () => {
  render(<R2Connect onConnected={vi.fn()} />);
  const user = await signedIn();
  await user.click(screen.getByRole("button", { name: "Load buckets" }));
  await user.click(await screen.findByRole("checkbox", { name: "photos" }));
  await user.click(screen.getByRole("checkbox", { name: "screenshots" }));
  const photos = screen.getByRole("textbox", { name: "Public Base URL for photos" });
  expect(photos).toHaveValue("https://");
  await user.type(photos, "photos.example.com");
  await user.click(screen.getByRole("button", { name: "Add selected buckets" }));
  expect(r2Api.connect).toHaveBeenCalledWith(expect.objectContaining({ publicBaseUrls: { photos: "https://photos.example.com" } }));
});
