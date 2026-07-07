import { describe, expect, it } from "vitest";
import { syncSystemTheme } from "./theme";

function makeMediaQuery(matches: boolean) {
  let listener: ((event: MediaQueryListEvent) => void) | undefined;

  return {
    query: {
      matches,
      addEventListener: (_type: "change", nextListener: (event: MediaQueryListEvent) => void) => {
        listener = nextListener;
      },
      removeEventListener: (_type: "change", nextListener: (event: MediaQueryListEvent) => void) => {
        if (listener === nextListener) listener = undefined;
      },
    } as MediaQueryList,
    change(nextMatches: boolean) {
      listener?.({ matches: nextMatches } as MediaQueryListEvent);
    },
  };
}

describe("syncSystemTheme", () => {
  it("applies dark mode when the system preference is dark", () => {
    const media = makeMediaQuery(true);

    const cleanup = syncSystemTheme(media.query);

    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    cleanup();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
  });

  it("updates the root class when the system preference changes", () => {
    const media = makeMediaQuery(false);

    const cleanup = syncSystemTheme(media.query);
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("light");

    media.change(true);
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    media.change(false);
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("light");

    cleanup();
    document.documentElement.style.colorScheme = "";
  });
});
