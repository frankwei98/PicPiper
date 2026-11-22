import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppSettings, MiniCompressionChanges, MiniItem, MiniSettings, MiniState, MiniUploadTarget } from "@/api/backend";

const mockApi = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  onChanged: vi.fn(),
  state: vi.fn(),
  thumbnail: vi.fn(),
  add: vi.fn(),
  upload: vi.fn(),
  targets: vi.fn(),
  clear: vi.fn(),
  restore: vi.fn(),
  copyImage: vi.fn(),
  save: vi.fn(),
  window: vi.fn(),
  copy: vi.fn(),
  copyAll: vi.fn(),
  export: vi.fn(),
}));
const mockDesktop = vi.hoisted(() => ({
  open: vi.fn(),
  fileDropListener: undefined as ((paths: string[]) => void) | undefined,
}));

vi.mock("@/api/backend", () => ({
  defaultMiniSettings: { enabled: false, targetFormat: "webp", quality: 90, action: "clipboard", profileId: "", linkFormat: "url" },
  settingsApi: { loadSettings: mockApi.loadSettings, onChanged: mockApi.onChanged },
  imageApi: { cancelImageTask: vi.fn(async () => {}) },
  miniApi: {
    state: mockApi.state,
    thumbnail: mockApi.thumbnail,
    add: mockApi.add,
    upload: mockApi.upload,
    targets: mockApi.targets,
    clear: mockApi.clear,
    restore: mockApi.restore,
    copyImage: mockApi.copyImage,
    saveCompression: mockApi.save,
    window: mockApi.window,
    copy: mockApi.copy,
    copyAll: mockApi.copyAll,
    export: mockApi.export,
  },
}));
vi.mock("@/platform/desktop", () => ({
  open: mockDesktop.open,
  onFileDrop: (listener: (paths: string[]) => void) => {
    mockDesktop.fileDropListener = listener;
    return vi.fn();
  },
}));

import { MiniPage } from "./MiniPage";

const profile = { id: "profile-1", name: "Public bucket", endpoint: "https://s3.example.test", region: "auto", bucket: "images", accessKeyId: "fake", pathStyle: true, publicBaseUrl: "https://cdn.example.test", defaultPrefix: "" };
const defaultSettings: AppSettings = { profiles: [profile], namingTemplate: "{slug}.{ext}", mini: { enabled: true, targetFormat: "webp", quality: 90, action: "clipboard", profileId: "", linkFormat: "url" } };
const defaultTarget: MiniUploadTarget = { profileId: profile.id, name: profile.name, bucket: profile.bucket, bucketKey: "images" };
const secondTarget: MiniUploadTarget = { profileId: "profile-2", name: "Archive", bucket: "archive", bucketKey: "archive" };
const emptyState: MiniState = { revision: 1, items: [], busy: false, copied: "", error: "" };
const completedItem: MiniItem = {
  id: "item-1", name: "source.png", status: "completed", outputName: "result.webp", originalBytes: 20_000, outputBytes: 10_000,
  url: "https://cdn.example.test/result.webp", error: "", warning: "", completedAt: "2026-11-14T10:00:00Z",
  links: {
    url: "https://cdn.example.test/result.webp",
    html: '<img src="https://cdn.example.test/result.webp">',
    bbcode: "[img]https://cdn.example.test/result.webp[/img]",
    markdown: "![result](https://cdn.example.test/result.webp)",
  },
};
const completedWithoutURL: MiniItem = { ...completedItem, id: "item-without-url", url: "", links: undefined };
const resultState: MiniState = { ...emptyState, items: [completedItem] };
const resultWithoutURLState: MiniState = { ...emptyState, items: [completedWithoutURL] };

function prepare(settings: AppSettings = defaultSettings, state: MiniState = emptyState, targets: MiniUploadTarget[] = [defaultTarget]) {
  mockApi.loadSettings.mockResolvedValue(settings);
  mockApi.state.mockResolvedValue(state);
  mockApi.thumbnail.mockResolvedValue({ dataUrl: "data:image/png;base64,AA==" });
  mockApi.add.mockResolvedValue(state);
  mockApi.upload.mockResolvedValue(state);
  mockApi.targets.mockResolvedValue(targets);
  mockApi.clear.mockResolvedValue({ ...emptyState, canUndoClear: true });
  mockApi.restore.mockResolvedValue({ ...state, canUndoClear: false });
  mockApi.copyImage.mockResolvedValue(undefined);
  mockApi.save.mockImplementation(async (changes: MiniCompressionChanges) => ({ ...settings.mini!, ...changes }));
  mockApi.onChanged.mockReturnValue(vi.fn());
  mockApi.window.mockResolvedValue(undefined);
  mockApi.copy.mockResolvedValue(undefined);
  mockApi.copyAll.mockResolvedValue(undefined);
  mockApi.export.mockResolvedValue(["/tmp/result.webp"]);
  mockDesktop.fileDropListener = undefined;
}

it("saves one result and the selected results to a chosen folder", async () => {
  const user = userEvent.setup();
  await renderReady(defaultSettings, { ...resultState, items: [completedItem, { ...completedItem, id: "item-2", outputName: "second.webp" }] });
  mockDesktop.open.mockResolvedValue("/tmp/images");
  await user.click(screen.getByRole("button", { name: /Save to local folder: result.webp/ }));
  await waitFor(() => expect(mockApi.export).toHaveBeenCalledWith(["item-1"], "/tmp/images"));
  expect(mockDesktop.open).toHaveBeenCalledWith({ directory: true });
  await selectRows(user, ["result.webp", "second.webp"]);
  await user.click(screen.getByRole("button", { name: "Save to local folder" }));
  await waitFor(() => expect(mockApi.export).toHaveBeenLastCalledWith(["item-1", "item-2"], "/tmp/images"));
  expect(await screen.findByRole("status")).toHaveTextContent("Saved 1 file(s) to /tmp/images");
});

async function renderReady(settings: AppSettings = defaultSettings, state: MiniState = emptyState, targets: MiniUploadTarget[] = [defaultTarget]) {
  prepare(settings, state, targets);
  const view = render(<MiniPage />);
  await screen.findByRole("button", { name: /Drop (images to compress|more images)/ });
  return view;
}

async function selectRows(user: ReturnType<typeof userEvent.setup>, names: string[]) {
  for (const name of names) await user.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
}

async function openUploadDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Upload selected" }));
  return screen.findByRole("dialog");
}

beforeEach(() => {
  vi.clearAllMocks();
  prepare();
});
afterEach(() => cleanup());

it("opens the compression settings from the header and keeps the compact header actions", async () => {
  const user = userEvent.setup();
  await renderReady();

  expect(screen.queryByText("MINI")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Adjust compression settings" })).toHaveTextContent("WEBP");
  expect(screen.getByRole("button", { name: "Adjust compression settings" })).toHaveTextContent("90%");
  await user.click(screen.getByRole("button", { name: "Open full window" }));
  await user.click(screen.getByRole("button", { name: "Close Mini" }));
  expect(mockApi.window).toHaveBeenNthCalledWith(1, "main");
  expect(mockApi.window).toHaveBeenNthCalledWith(2, "close");
});

it("keeps S3 targets and link formats inside the manual upload dialog", async () => {
  const user = userEvent.setup();
  await renderReady(defaultSettings, { ...emptyState, items: [completedItem] }, [defaultTarget, secondTarget]);

  expect(screen.queryByRole("combobox", { name: "S3 profile" })).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Link format" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Upload all" })).not.toBeInTheDocument();
  expect(screen.queryByText("Copies the image after compression. Upload to S3 anytime.")).not.toBeInTheDocument();
  await selectRows(user, [completedItem.outputName]);
  const dialog = await openUploadDialog(user);
  expect(within(dialog).getByRole("combobox", { name: "S3 profile" })).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "Markdown" })).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "Upload and copy links" })).toBeEnabled();
  expect(within(dialog).getByRole("button", { name: "HTML" })).toBeVisible();
});

it("shows indeterminate selection and uploads the selected IDs only after confirmation", async () => {
  const user = userEvent.setup();
  const second = { ...completedItem, id: "item-2", outputName: "second.webp" };
  await renderReady(defaultSettings, { ...emptyState, items: [completedItem, second] });

  await selectRows(user, [completedItem.outputName]);
  const selectAll = screen.getByRole("checkbox", { name: "Select all recent results" }) as HTMLInputElement;
  expect(selectAll.indeterminate).toBe(true);
  await user.click(screen.getByRole("button", { name: "Upload selected" }));
  const dialog = await screen.findByRole("dialog");
  expect(mockApi.upload).not.toHaveBeenCalled();
  await user.selectOptions(within(dialog).getByRole("combobox", { name: "S3 profile" }), defaultTarget.profileId);
  await user.click(within(dialog).getByRole("button", { name: "Markdown" }));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Upload and copy links" })).toBeEnabled());
  await user.click(within(dialog).getByRole("button", { name: "Upload and copy links" }));

  await waitFor(() => expect(mockApi.upload).toHaveBeenCalledWith([completedItem.id], profile.id, "markdown", defaultTarget.bucketKey));
});

it("refreshes a changed bucket after failed confirmation and requires another confirmation", async () => {
  const user = userEvent.setup();
  await renderReady(defaultSettings, resultWithoutURLState);
  await user.click(screen.getByRole("button", { name: "Upload result.webp to S3" }));
  const dialog = await screen.findByRole("dialog");
  const confirm = () => within(dialog).getByRole("button", { name: "Upload and copy links" });
  await waitFor(() => expect(confirm()).toBeEnabled());
  expect(within(dialog).getByRole("option", { name: "Public bucket / images" })).toBeInTheDocument();
  mockApi.upload.mockRejectedValueOnce({ code: "miniUploadTargetChanged", message: "Refresh to retry" });
  await user.click(confirm());
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Refresh to retry");
  expect(mockApi.upload).toHaveBeenCalledWith([completedWithoutURL.id], profile.id, "url", defaultTarget.bucketKey);
  expect(confirm()).toBeDisabled();

  let finishRefresh: ((targets: MiniUploadTarget[]) => void) | undefined;
  mockApi.targets.mockImplementationOnce(() => new Promise<MiniUploadTarget[]>((resolve) => { finishRefresh = resolve; }));
  await user.click(within(dialog).getByRole("button", { name: "Refresh to retry" }));
  expect(confirm()).toBeDisabled();
  await act(async () => finishRefresh?.([{ ...defaultTarget, bucket: "replacement", bucketKey: "replacement-key" }]));
  await waitFor(() => expect(confirm()).toBeEnabled());
  expect(within(dialog).getByRole("option", { name: "Public bucket / replacement" })).toBeInTheDocument();
  expect(mockApi.upload).toHaveBeenCalledTimes(1);
  await user.click(confirm());
  await waitFor(() => expect(mockApi.upload).toHaveBeenLastCalledWith([completedWithoutURL.id], profile.id, "url", "replacement-key"));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("can retry loading upload destinations after a refresh fails", async () => {
  const user = userEvent.setup();
  await renderReady(defaultSettings, resultWithoutURLState);
  mockApi.targets.mockRejectedValueOnce(new Error("target refresh failed"));
  await user.click(screen.getByRole("button", { name: "Upload result.webp to S3" }));
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("target refresh failed");
  expect(within(dialog).getByRole("button", { name: "Upload and copy links" })).toBeDisabled();
  await user.click(within(dialog).getByRole("button", { name: "Refresh to retry" }));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Upload and copy links" })).toBeEnabled());
  expect(mockApi.upload).not.toHaveBeenCalled();
});

it("uploads a mixed selection together and labels the confirmation with its count", async () => {
  const user = userEvent.setup();
  const alreadyUploaded: MiniItem = { ...completedItem, uploads: { images: "https://cdn.example.test/result.webp" } };
  const fresh: MiniItem = { ...completedWithoutURL, id: "item-2", outputName: "fresh.webp" };
  await renderReady(defaultSettings, { ...emptyState, items: [alreadyUploaded, fresh] });
  await selectRows(user, [alreadyUploaded.outputName, fresh.outputName]);
  const dialog = await openUploadDialog(user);

  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Upload 1 and copy links" })).toBeEnabled());
  await user.click(within(dialog).getByRole("button", { name: "Upload 1 and copy links" }));
  expect(mockApi.upload).toHaveBeenCalledWith([alreadyUploaded.id, fresh.id], profile.id, "url", defaultTarget.bucketKey);
});

it("copies existing links when all selected results already have the target bucket link", async () => {
  const user = userEvent.setup();
  const uploaded: MiniItem = { ...completedItem, uploads: { images: "https://cdn.example.test/result.webp" } };
  const second = { ...uploaded, id: "item-2", outputName: "second.webp" };
  await renderReady(defaultSettings, { ...emptyState, items: [uploaded, second] });
  await selectRows(user, [uploaded.outputName, second.outputName]);
  const dialog = await openUploadDialog(user);
  await user.selectOptions(within(dialog).getByRole("combobox", { name: "S3 profile" }), defaultTarget.profileId);

  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Copy existing links" })).toBeEnabled());
  await user.click(within(dialog).getByRole("button", { name: "Copy existing links" }));

  expect(mockApi.upload).toHaveBeenCalledWith([uploaded.id, second.id], profile.id, "url", defaultTarget.bucketKey);
  expect(mockApi.add).not.toHaveBeenCalled();
});

it("opens the manual upload dialog from an item's upload button", async () => {
  const user = userEvent.setup();
  await renderReady(defaultSettings, resultWithoutURLState);

  await user.click(screen.getByRole("button", { name: "Upload result.webp to S3" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Upload and copy links" })).toBeEnabled());
  await user.click(within(dialog).getByRole("button", { name: "Upload and copy links" }));

  expect(mockApi.upload).toHaveBeenCalledWith([completedWithoutURL.id], profile.id, "url", defaultTarget.bucketKey);
  expect(mockApi.add).not.toHaveBeenCalled();
  expect(mockApi.save).not.toHaveBeenCalled();
});

it("allows opening the upload dialog without targets but disables confirmation", async () => {
  const user = userEvent.setup();
  await renderReady({ ...defaultSettings, profiles: [] }, resultWithoutURLState, []);
  await selectRows(user, [completedWithoutURL.outputName]);
  const dialog = await openUploadDialog(user);

  await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "S3 profile" })).toHaveValue(""));
  expect(within(dialog).getByRole("button", { name: "Upload and copy links" })).toBeDisabled();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Copy image result.webp" })).toBeEnabled();
});

it("clears the local result list and restores it through Undo without deleting S3 objects", async () => {
  const user = userEvent.setup();
  const cleared: MiniState = { ...emptyState, canUndoClear: true };
  mockApi.clear.mockResolvedValue(cleared);
  mockApi.restore.mockResolvedValue(resultState);
  await renderReady(defaultSettings, resultState);

  await user.click(screen.getByRole("button", { name: "Clear list" }));
  expect(mockApi.clear).toHaveBeenCalledOnce();
  expect(mockApi.upload).not.toHaveBeenCalled();
  expect(mockApi.add).not.toHaveBeenCalled();
  expect(await screen.findByText("List cleared")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(mockApi.restore).toHaveBeenCalledOnce();
  expect(await screen.findByText("result.webp")).toBeVisible();
});

it("adds dropped file paths through the Mini API", async () => {
  await renderReady();
  mockApi.add.mockResolvedValue({ ...emptyState, items: [completedItem] });

  mockDesktop.fileDropListener?.(["/tmp/drop image.png"]);

  await waitFor(() => expect(mockApi.add).toHaveBeenCalledWith(["/tmp/drop image.png"]));
  expect(await screen.findByText("result.webp")).toBeVisible();
});

it("ignores a poll error from before a successful add", async () => {
  prepare();
  let rejectPoll: ((cause: Error) => void) | undefined;
  mockApi.state.mockImplementationOnce(() => new Promise<MiniState>((_resolve, reject) => { rejectPoll = reject; }));
  mockApi.add.mockResolvedValue({ ...emptyState, items: [completedItem] });
  render(<MiniPage />);
  await screen.findByRole("button", { name: /Drop (images to compress|more images)/ });

  mockDesktop.fileDropListener?.(["/tmp/drop image.png"]);
  expect(await screen.findByText("result.webp")).toBeVisible();
  await act(async () => rejectPoll?.(new Error("stale poll failure")));

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText("result.webp")).toBeVisible();
});

it("shows errors from the current queue poll", async () => {
  prepare();
  mockApi.state.mockRejectedValueOnce(new Error("current poll failure"));
  render(<MiniPage />);

  expect(await screen.findByRole("alert")).toHaveTextContent("current poll failure");
});

it("preloads thumbnails relative to the scroll list and reuses them on return", async () => {
  let notify!: IntersectionObserverCallback;
  const observe = vi.fn();
  const disconnect = vi.fn();
  const configure = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
      notify = callback;
      configure(options);
    }
    observe = observe;
    disconnect = disconnect;
  });
  try {
    const view = await renderReady(defaultSettings, resultState);
    await screen.findByText(completedItem.outputName);
    const thumbnail = view.container.querySelector(".mini-thumb");
    await waitFor(() => expect(configure).toHaveBeenCalledWith({ root: screen.getByTestId("mini-results-scroll"), rootMargin: "160px 0px" }));
    expect(observe).toHaveBeenCalledWith(thumbnail);
    expect(mockApi.thumbnail).not.toHaveBeenCalled();

    const intersect = (isIntersecting: boolean) => act(async () => {
      notify([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    await intersect(true);
    expect(thumbnail?.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,AA==");
    await intersect(false);
    expect(thumbnail?.querySelector("img")).toBeNull();
    await intersect(true);
    expect(thumbnail?.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,AA==");
    expect(mockApi.thumbnail).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("polls with the current revision and leaves a loaded thumbnail in place for an unchanged reply", async () => {
  vi.useFakeTimers();
  try {
    prepare(defaultSettings, resultState);
    mockApi.state.mockResolvedValueOnce({ ...resultState, revision: 17 }).mockResolvedValue(null);
    const view = render(<MiniPage />);
    await act(async () => {});
    const image = view.container.querySelector(".mini-thumb img");
    expect(image).toHaveAttribute("src", "data:image/png;base64,AA==");
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mockApi.state).toHaveBeenLastCalledWith(17);
    expect(mockApi.thumbnail).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector(".mini-thumb img")).toBe(image);
    view.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it("restores results from Mini state after closing and remounting", async () => {
  const user = userEvent.setup();
  const view = await renderReady(defaultSettings, resultState);
  expect(await screen.findByText("result.webp")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Close Mini" }));
  view.unmount();
  render(<MiniPage />);

  expect(await screen.findByText("result.webp")).toBeVisible();
  expect(mockApi.state).toHaveBeenCalledTimes(2);
});

it("uses a result's saved link format when copying its link", async () => {
  const user = userEvent.setup();
  const savedFormat = { ...completedItem, uploads: { images: completedItem.url }, linkFormat: "html" as const };
  const settings: AppSettings = { ...defaultSettings, mini: { ...defaultSettings.mini!, profileId: profile.id, linkFormat: "markdown" } satisfies MiniSettings };
  await renderReady(settings, { ...emptyState, items: [savedFormat] });

  await user.click(screen.getByRole("button", { name: "Copy image result.webp" }));
  await waitFor(() => expect(mockApi.copyImage).toHaveBeenCalledWith(savedFormat.id));
  await waitFor(() => expect(screen.getByRole("button", { name: "Copy link result.webp" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Copy link result.webp" }));

  await waitFor(() => expect(mockApi.copy).toHaveBeenCalledWith(savedFormat.id, "html"));
});

it("preserves newer Mini preferences when a stale panel edits only quality", async () => {
  const user = userEvent.setup();
  await renderReady();
  let stored: MiniSettings = { ...defaultSettings.mini!, targetFormat: "avif", enabled: false, profileId: "latest-profile", linkFormat: "markdown" };
  mockApi.save.mockImplementation(async (changes: MiniCompressionChanges) => { stored = { ...stored, ...changes }; return stored; });
  await user.click(screen.getByRole("button", { name: "Adjust compression settings" }));
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByRole("spinbutton", { name: "Quality" }), { target: { value: "85" } });
  await user.click(dialog.getByRole("button", { name: "Save Mini settings" }));
  await waitFor(() => expect(mockApi.save).toHaveBeenCalledWith({ quality: 85 }));
  expect(stored).toMatchObject({ targetFormat: "avif", quality: 85, enabled: false, profileId: "latest-profile", linkFormat: "markdown" });
  expect(screen.getByRole("button", { name: "Adjust compression settings" })).toHaveTextContent("AVIF");
});

it("refreshes saved settings and preserves a quality change made while its dialog is open", async () => {
  let changed: (() => void) | undefined;
  mockApi.onChanged.mockImplementation((listener: () => void) => { changed = listener; return vi.fn(); });
  let stored: MiniSettings = { ...defaultSettings.mini! };
  mockApi.loadSettings.mockImplementation(async () => ({ ...defaultSettings, mini: { ...stored } }));
  mockApi.state.mockResolvedValue(emptyState);
  mockApi.save.mockImplementation(async (changes: MiniCompressionChanges) => { stored = { ...stored, ...changes }; return stored; });
  const user = userEvent.setup();
  render(<MiniPage />);
  const header = await screen.findByRole("button", { name: "Adjust compression settings" });
  await waitFor(() => expect(header).toBeEnabled());
  await user.click(header);
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByRole("combobox", { name: "Image format" }), { target: { value: "png" } });
  stored = { ...stored, quality: 77 };
  await act(async () => changed?.());
  await waitFor(() => expect(header).toHaveTextContent("77%"));
  await user.click(dialog.getByRole("button", { name: "Save Mini settings" }));
  await waitFor(() => expect(mockApi.save).toHaveBeenCalledWith({ targetFormat: "png" }));
  expect(stored).toMatchObject({ targetFormat: "png", quality: 77 });
});

it("ignores older settings replies and unsubscribes when the panel closes", async () => {
  let changed: (() => void) | undefined;
  const unsubscribe = vi.fn();
  mockApi.onChanged.mockImplementation((listener: () => void) => { changed = listener; return unsubscribe; });
  let resolveOld: ((settings: AppSettings) => void) | undefined;
  mockApi.loadSettings.mockImplementationOnce(() => new Promise<AppSettings>((resolve) => { resolveOld = resolve; }));
  mockApi.loadSettings.mockResolvedValue({ ...defaultSettings, mini: { ...defaultSettings.mini!, targetFormat: "avif" } });
  const view = render(<MiniPage />);
  await act(async () => changed?.());
  const header = screen.getByRole("button", { name: "Adjust compression settings" });
  await waitFor(() => expect(header).toHaveTextContent("AVIF"));
  await act(async () => resolveOld?.(defaultSettings));
  expect(header).toHaveTextContent("AVIF");
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
