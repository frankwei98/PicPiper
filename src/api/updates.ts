import { useEffect } from "react";
import { isMyGo } from "mygo-runtime";
import { Backend, events } from "../mygo";
import { getLanguagePreference } from "@/i18n";

export interface UpdateState {
  version: string;
  enabled: boolean;
  automaticChecks: boolean;
  automaticDownloads: boolean;
  lastCheck: string;
  availableVersion: string;
  restartDeferred: boolean;
}

async function call<T>(operation: string, payload: object = {}): Promise<T> {
  const response = JSON.parse(await Backend.call(operation, JSON.stringify(payload)));
  if (response.error) throw new Error(response.error.message);
  return response.data;
}

const browserState: UpdateState = { version: "", enabled: false, automaticChecks: false, automaticDownloads: false, lastCheck: "", availableVersion: "", restartDeferred: false };

export const updateApi = {
  state: () => isMyGo() ? call<UpdateState>("update_state") : Promise.resolve(browserState),
  check: () => call<void>("update_check"),
  preferences: (preferences: Pick<UpdateState, "automaticChecks" | "automaticDownloads">) => call<UpdateState>("update_preferences", preferences),
  subscribe: (listener: () => void) => isMyGo() ? events.updatesChanged.on(listener) : () => {},
  language: () => isMyGo() ? call<void>("update_locale", { language: getLanguagePreference() }) : Promise.resolve(),
};

// Calls are serialized so an older busy=false cannot overtake a new batch.
let activityWrites = Promise.resolve();
function activity(scope: string, busy: boolean) {
  activityWrites = activityWrites.then(() => call<void>("update_activity", { scope, busy })).catch(() => {});
}
export function useUpdateActivity(scope: "optimize" | "gallery", busy: boolean) {
  useEffect(() => {
    if (!isMyGo()) return;
    activity(scope, busy);
  }, [scope, busy]);
  useEffect(() => () => { if (isMyGo()) activity(scope, false); }, [scope]);
}

// Upload batches outlive gallery navigation. Their lease belongs to the async
// operation, rather than an effect that would clear it when the page unmounts.
export async function beginUpdateActivity(scope: "gallery"): Promise<() => Promise<void>> {
  if (!isMyGo()) return async () => {};
  const id = crypto.randomUUID();
  await call<void>("update_activity", { scope, id, busy: true });
  return () => call<void>("update_activity", { scope, id, busy: false }).catch(() => {});
}
