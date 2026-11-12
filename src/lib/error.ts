interface SerializedAppError {
  code?: unknown;
  message?: unknown;
}

function serializedAppError(error: unknown): SerializedAppError | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return error as SerializedAppError;
}

/**
 * Returns a user-safe message from either a native Error or a serialized
 * structured error returned by the Go/MyGo backend. Backend errors cross the
 * bridge as plain objects, which are not instances of JavaScript's Error.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  const message = serializedAppError(error)?.message;
  if (typeof message === "string" && message.trim()) return message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

export function errorCode(error: unknown): string | undefined {
  const code = serializedAppError(error)?.code;
  return typeof code === "string" && code ? code : undefined;
}
