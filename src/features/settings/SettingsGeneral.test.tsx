import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/api/backend";

const { saveSettings } = vi.hoisted(() => ({ saveSettings: vi.fn(async (_settings: AppSettings) => {}) }));
vi.mock("@/api/backend", () => ({
  settingsApi: { saveSettings },
  defaultMiniSettings: { enabled: false, targetFormat: "webp", quality: 90, action: "clipboard", profileId: "", linkFormat: "url" },
}));

import { SettingsPage } from "./SettingsPage";

const baseSettings: AppSettings = { profiles: [], namingTemplate: "{slug}.{ext}" };
const mini = { enabled: true, targetFormat: "webp", quality: 90, action: "clipboard", profileId: "", linkFormat: "url" } satisfies NonNullable<AppSettings["mini"]>;

describe("General settings", () => {
  beforeEach(() => { saveSettings.mockClear(); });

  it("defaults to quitting and saves an independent background preference without a status icon", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(<SettingsPage settings={baseSettings} onSettingsChange={onSettingsChange} />);
    const close = screen.getByRole("combobox", { name: "Close window behavior" });
    expect(close).toBeEnabled();
    expect(close).toHaveValue("quit");
    await user.selectOptions(close, "background");
    await user.click(screen.getByRole("button", { name: "Save general settings" }));
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ closeBehavior: "background", mini: expect.objectContaining({ enabled: false }) }));
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ closeBehavior: "background" }));
  });

  it.each([[12, 6], [10, 5], [11, 6]])("shows the 50%% automatic task count for %i CPU cores", (cpuCount, automaticCount) => {
    render(<SettingsPage settings={baseSettings} onSettingsChange={() => {}} processingLimits={{ cpuCount, defaultConcurrency: automaticCount, concurrency: automaticCount }} />);
    const concurrency = screen.getByRole("combobox", { name: "Parallel image tasks" });
    expect(concurrency).toHaveValue("0");
    expect(screen.getByRole("option", { name: `Auto (${automaticCount} tasks)` })).toBeInTheDocument();
  });

  it("saves a manually selected processing concurrency", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(<SettingsPage settings={baseSettings} onSettingsChange={onSettingsChange} processingLimits={{ cpuCount: 12, defaultConcurrency: 6, concurrency: 6 }} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Parallel image tasks" }), "4");
    await user.click(screen.getByRole("button", { name: "Save general settings" }));
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ processingConcurrency: 4 }));
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ processingConcurrency: 4 }));
  });

  it("fills in and follows an existing processing concurrency setting", () => {
    const view = render(<SettingsPage settings={{ ...baseSettings, processingConcurrency: 5 }} onSettingsChange={() => {}} processingLimits={{ cpuCount: 12, defaultConcurrency: 6, concurrency: 5 }} />);
    const concurrency = screen.getByRole("combobox", { name: "Parallel image tasks" });
    expect(concurrency).toHaveValue("5");
    view.rerender(<SettingsPage settings={{ ...baseSettings, processingConcurrency: 3 }} onSettingsChange={() => {}} processingLimits={{ cpuCount: 12, defaultConcurrency: 6, concurrency: 3 }} />);
    expect(concurrency).toHaveValue("3");
  });

  it("keeps the concurrency draft when saving fails", async () => {
    const user = userEvent.setup();
    saveSettings.mockRejectedValueOnce(new Error("disk unavailable"));
    render(<SettingsPage settings={baseSettings} onSettingsChange={() => {}} processingLimits={{ cpuCount: 12, defaultConcurrency: 6, concurrency: 6 }} />);
    const concurrency = screen.getByRole("combobox", { name: "Parallel image tasks" });
    await user.selectOptions(concurrency, "4");
    await user.click(screen.getByRole("button", { name: "Save general settings" }));
    expect(await screen.findByText("disk unavailable")).toBeInTheDocument();
    expect(concurrency).toHaveValue("4");
  });

  it.each(["quit", "background"] as const)("locks the effective choice and restores the saved %s preference when disabling the icon", async (preference) => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    const view = render(<SettingsPage settings={{ ...baseSettings, closeBehavior: preference }} onSettingsChange={onSettingsChange} />);
    const close = screen.getByRole("combobox", { name: "Close window behavior" });
    await user.click(screen.getByRole("switch", { name: "Show status bar icon" }));
    expect(close).toBeDisabled();
    expect(close).toHaveValue("background");
    expect(close).toHaveAccessibleDescription("The status bar icon needs Pic Piper to keep running in the background. Disable the icon to change this behavior.");
    await user.click(screen.getByRole("button", { name: "Save general settings" }));
    await waitFor(() => expect(onSettingsChange).toHaveBeenCalled());
    const saved = onSettingsChange.mock.calls[0][0] as AppSettings;
    expect(saved.closeBehavior).toBe(preference);
    expect(saved.mini?.enabled).toBe(true);
    view.rerender(<SettingsPage settings={saved} onSettingsChange={onSettingsChange} />);
    await user.click(screen.getByRole("switch", { name: "Show status bar icon" }));
    expect(close).toBeEnabled();
    expect(close).toHaveValue(preference);
    expect(close).not.toHaveAttribute("aria-describedby");
    await user.click(screen.getByRole("button", { name: "Save general settings" }));
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ closeBehavior: preference, mini: expect.objectContaining({ enabled: false }) }));
  });

  it("locks the control when an enabled icon arrives with loaded settings", async () => {
    const view = render(<SettingsPage settings={baseSettings} onSettingsChange={() => {}} />);
    view.rerender(<SettingsPage settings={{ ...baseSettings, mini, closeBehavior: "quit" }} onSettingsChange={() => {}} />);
    const close = screen.getByRole("combobox", { name: "Close window behavior" });
    expect(close).toBeDisabled();
    expect(close).toHaveValue("background");
    expect(screen.getByRole("combobox", { name: "Default image format" })).toHaveValue("webp");
    expect(screen.getByRole("spinbutton", { name: "Default image quality" })).toHaveValue(90);
  });

  it("toggles the status icon from its visible right-hand control", async () => {
    const user = userEvent.setup();
    render(<SettingsPage settings={{ ...baseSettings, mini }} onSettingsChange={() => {}} />);
    const toggle = screen.getByRole("switch", { name: "Show status bar icon" });
    const visibleControl = toggle.closest("label");
    expect(visibleControl).not.toBeNull();
    await user.click(visibleControl!);
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "Close window behavior" })).toBeEnabled();
  });

  it("navigates across sidebar groups with the keyboard and identifies each active panel", async () => {
    const user = userEvent.setup();
    render(<SettingsPage settings={baseSettings} onSettingsChange={() => {}} />);
    screen.getByRole("tab", { name: "General" }).focus();
    for (const name of ["S3 profiles", "One-click authorization", "Links and naming"]) {
      await user.keyboard("{ArrowDown}");
      const tab = screen.getByRole("tab", { name });
      expect(tab).toHaveFocus();
      expect(tab).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tabpanel", { name })).toBeVisible();
    }
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "General" })).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "General" })).toBeVisible();
  });
});
