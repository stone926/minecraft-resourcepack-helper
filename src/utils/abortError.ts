interface ErrorWithCause {
  readonly name?: unknown;
  readonly cause?: unknown;
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
