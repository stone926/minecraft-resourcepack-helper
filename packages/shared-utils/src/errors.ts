interface ErrorWithCause {
  readonly name?: unknown;
  readonly cause?: unknown;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Recognizes AbortError across realms and through errors that preserve `cause`. */
export function isAbortError(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    const candidate = current as ErrorWithCause;
    if (candidate.name === "AbortError") {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export function createAbortError(message = "This operation was aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function abortSignalError(signal: AbortSignal, message?: string): Error {
  return signal.reason instanceof Error ? signal.reason : createAbortError(message);
}

export function abortSignalReason(signal: AbortSignal, message?: string): unknown {
  return signal.reason !== undefined ? signal.reason : createAbortError(message);
}

export function throwIfAborted(signal: AbortSignal | null | undefined, message?: string): void {
  if (signal?.aborted) {
    throw abortSignalError(signal, message);
  }
}
