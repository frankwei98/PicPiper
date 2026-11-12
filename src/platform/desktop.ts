import { t } from "@/i18n";
import { isMyGo, onFileDrop as subscribeFileDrop } from "mygo-runtime";
import { Backend, events } from "../mygo";

interface OpenOptions {
  multiple?: boolean;
  directory?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export async function open(options: OpenOptions = {}): Promise<string | string[] | null> {
  if (!isMyGo()) throw new Error(t("Open the desktop app to choose local files."));
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
  return subscribeFileDrop(({ paths }) => listener(paths));
}

export function onImagesOpened(listener: (paths: string[]) => void): () => void {
  if (!isMyGo()) return () => {};
  const offOpen = events.imagesOpened.on(listener);
  // The app keeps this subscription across views. Subscribe before draining
  // launch-time Open With requests so later native events cannot fall in a gap.
  void Backend.takeOpenedFiles().then((paths) => {
    if (paths.length) listener(paths);
  });
  return offOpen;
}
