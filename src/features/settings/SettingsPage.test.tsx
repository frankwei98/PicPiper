import { render, screen } from "@testing-library/react";
import { SettingsPage } from "./SettingsPage";

describe("SettingsPage", () => {
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
});
