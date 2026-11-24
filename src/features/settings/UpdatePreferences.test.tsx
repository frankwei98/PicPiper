import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "@/api/updates";

const { state, check, preferences, subscribe } = vi.hoisted(() => ({
  state: vi.fn(),
  check: vi.fn(),
  preferences: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("@/api/updates", () => ({ updateApi: { state, check, preferences, subscribe } }));

import { UpdatePreferences } from "./UpdatePreferences";

const current: UpdateState = {
  version: "1.2.3",
  enabled: true,
  automaticChecks: true,
  automaticDownloads: false,
  lastCheck: "2026-11-13T10:00:00Z",
  availableVersion: "1.3.0",
  restartDeferred: true,
};

describe("Update preferences", () => {
  beforeEach(() => {
    state.mockReset().mockResolvedValue(current);
    check.mockReset().mockResolvedValue(undefined);
    preferences.mockReset().mockImplementation(async ({ automaticChecks, automaticDownloads }) => ({
      ...current, automaticChecks, automaticDownloads,
    }));
    subscribe.mockReset().mockImplementation(() => () => {});
  });

  it("shows the version, current update state, and enabled preferences", async () => {
    render(<UpdatePreferences />);
    expect(await screen.findByText("Version 1.2.3")).toBeVisible();
    expect(screen.getByRole("switch", { name: "Automatic update checks" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Automatic update downloads" })).not.toBeChecked();
    expect(screen.getByText("1.3.0")).toBeVisible();
    expect(screen.getByText("Finish your current tasks, then quit and reopen Pic Piper to use the update.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });

  it("disables updater controls when the release updater is unavailable", async () => {
    state.mockResolvedValue({ ...current, enabled: false });
    render(<UpdatePreferences />);
    expect(await screen.findByText("Updates are available in an installed release build.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Automatic update checks" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Automatic update downloads" })).toBeDisabled();
  });

  it("rolls back an optimistic preference change when saving fails", async () => {
    const user = userEvent.setup();
    preferences.mockRejectedValue(new Error("write failed"));
    render(<UpdatePreferences />);
    const toggle = await screen.findByRole("switch", { name: "Automatic update downloads" });
    await user.click(toggle);
    expect(preferences).toHaveBeenCalledWith({ automaticChecks: true, automaticDownloads: true });
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(await screen.findByText("write failed")).toBeVisible();
  });

  it("refreshes when the update service notifies the view", async () => {
    let notify: (() => void) | undefined;
    subscribe.mockImplementation((listener: () => void) => { notify = listener; return () => {}; });
    state.mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, availableVersion: "1.4.0" });
    render(<UpdatePreferences />);
    expect(await screen.findByText("1.3.0")).toBeVisible();
    notify?.();
    expect(await screen.findByText("1.4.0")).toBeVisible();
  });

  it("lets the user save preferences after the manual check state arrives", async () => {
    const user = userEvent.setup();
    let finishCheckState!: (snapshot: UpdateState) => void;
    state.mockResolvedValueOnce(current)
      .mockImplementationOnce(() => new Promise<UpdateState>((resolve) => { finishCheckState = resolve; }));
    render(<UpdatePreferences />);
    await screen.findByText("Version 1.2.3");

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(state).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();

    const toggle = screen.getByRole("switch", { name: "Automatic update downloads" });
    expect(toggle).toBeDisabled();
    await user.click(toggle);
    expect(preferences).not.toHaveBeenCalled();
    await act(async () => finishCheckState({ ...current, availableVersion: "1.4.0" }));

    expect(screen.getByText("1.4.0")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
    await user.click(toggle);
    expect(preferences).toHaveBeenCalledWith({ automaticChecks: true, automaticDownloads: true });
    expect(toggle).toBeChecked();
  });

  it("keeps the check button disabled until the manual check itself returns", async () => {
    const user = userEvent.setup();
    let notify!: () => void;
    let finishCheck!: () => void;
    subscribe.mockImplementation((listener: () => void) => { notify = listener; return () => {}; });
    check.mockImplementationOnce(() => new Promise<void>((resolve) => { finishCheck = resolve; }));
    render(<UpdatePreferences />);
    await screen.findByText("Version 1.2.3");

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    await act(async () => notify());
    expect(state).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Automatic update checks" })).toBeDisabled();

    await act(async () => finishCheck());
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Automatic update checks" })).toBeEnabled();
  });

  it("ignores an old state response after the panel becomes inactive", async () => {
    let resolveFirst!: (value: UpdateState) => void;
    state.mockImplementationOnce(() => new Promise<UpdateState>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ ...current, version: "2.0.0" });
    const view = render(<UpdatePreferences isActive />);
    view.rerender(<UpdatePreferences isActive={false} />);
    view.rerender(<UpdatePreferences isActive />);
    expect(await screen.findByText("Version 2.0.0")).toBeVisible();
    resolveFirst({ ...current, version: "1.0.0" });
    await waitFor(() => expect(screen.queryByText("Version 1.0.0")).not.toBeInTheDocument());
    expect(screen.getByText("Version 2.0.0")).toBeVisible();
  });
});
