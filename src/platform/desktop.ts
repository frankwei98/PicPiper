import { isMyGo, onFileDrop as subscribeFileDrop } from "mygo-runtime";
import { Backend, events } from "../mygo";

interface OpenOptions {
  multiple?: boolean;
  directory?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export async function open(options: OpenOptions = {}): Promise<string | string[] | null> {
  if (!isMyGo()) throw new Error("Open the desktop app to choose local files.");
  const paths = await Backend.open(JSON.stringify(options));
  if (!paths?.length) return null;
  return options.multiple ? paths : paths[0];
}

export async function openUrl(url: string): Promise<void> {
  await Backend.openUrl(url);
}

export async function writeClipboard(text: string): Promise<void> {
  await Backend.writeClipboard(text);
}

export function onFileDrop(listener: (paths: string[]) => void): () => void {
  if (!isMyGo()) return () => {};
  const offDrop = subscribeFileDrop(({ paths }) => listener(paths));
  const offOpen = events.imagesOpened.on(listener);
  // A launch-time Open With can arrive before React has subscribed.
  void Backend.takeOpenedFiles().then((paths) => {
    if (paths.length) listener(paths);
  });
  return () => { offDrop(); offOpen(); };
}
