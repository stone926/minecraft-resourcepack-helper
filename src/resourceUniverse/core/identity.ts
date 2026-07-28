/** Shared identity helpers for provider/project bookkeeping and DTO merging. */

export function providerProjectKey(providerId: string, projectId: string): string {
  return `${providerId}\0${projectId}`;
}

export function requireIdentity(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty identity.`);
  }
  return value.trim();
}

export function isEditableUri(uri: string): boolean {
  return uri.startsWith("file:") || uri.startsWith("vscode-remote:");
}

/**
 * Replaces previous entries with incoming ones sharing the same identity.
 * Insertion order is kept unless `sorted` asks for identity order.
 */
export function mergeByIdentity<T>(
  previous: readonly T[],
  incoming: readonly T[],
  identity: (value: T) => string,
  options: { sorted?: boolean } = {}
): T[] {
  const merged = new Map([...previous, ...incoming].map(value => [identity(value), value]));
  const values = [...merged.values()];
  return options.sorted
    ? values.sort((left, right) => identity(left).localeCompare(identity(right), "en"))
    : values;
}
