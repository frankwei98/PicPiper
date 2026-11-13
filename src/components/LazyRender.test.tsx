import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LazyRender } from "./LazyRender";

afterEach(() => vi.unstubAllGlobals());
function observers() {
  let changed!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { changed = callback; }
    observe() {} disconnect = disconnect;
  });
  return { visible: (isIntersecting: boolean) => act(() => changed([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver)), disconnect };
}

it("mounts content near the viewport, unloads it offscreen, and preserves its height", () => {
  const observer = observers();
  const content = vi.fn(() => <button>Expensive content</button>);
  const { container, unmount } = render(<LazyRender label="photo" placeholder={<p>Skeleton</p>}>{content}</LazyRender>);
  expect(content).not.toHaveBeenCalled();
  observer.visible(true);
  expect(screen.getByRole("button")).toBeInTheDocument();
  vi.spyOn(container.firstElementChild!, "getBoundingClientRect").mockReturnValue({ height: 240, width: 220 } as DOMRect);
  observer.visible(false);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(container.firstElementChild).toHaveStyle({ minHeight: "240px" });
  observer.visible(true);
  expect(screen.getByRole("button")).toBeInTheDocument();
  expect(container.firstElementChild).not.toHaveStyle({ minHeight: "240px" });
  unmount();
  expect(observer.disconnect).toHaveBeenCalled();
});

it("lets keyboard users mount placeholders and retains a focused card while scrolling", () => {
  const observer = observers();
  const { container } = render(<LazyRender label="photo" placeholder={<p>Skeleton</p>}>{() => <button>Action</button>}</LazyRender>);
  const boundary = container.firstElementChild as HTMLElement;
  expect(boundary).toHaveAttribute("tabindex", "0");
  act(() => boundary.focus());
  expect(screen.getByRole("button")).toBeInTheDocument();
  act(() => screen.getByRole("button").focus());
  observer.visible(false);
  expect(screen.getByRole("button")).toHaveFocus();
  fireEvent.blur(screen.getByRole("button"), { relatedTarget: document.body });
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("renders normally when IntersectionObserver is unavailable", () => {
  render(<LazyRender label="photo" placeholder={<p>Skeleton</p>}>{() => <button>Action</button>}</LazyRender>);
  expect(screen.getByRole("button")).toBeInTheDocument();
});
