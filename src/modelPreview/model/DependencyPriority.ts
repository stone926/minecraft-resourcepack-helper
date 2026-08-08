export interface WatchableDependency {
  watchOnly?: boolean;
}

/** Keep an effective dependency when the same path is also observed as a fallback candidate. */
export function setDependencyWithActualPriority<T extends WatchableDependency>(
  dependencies: Map<string, T>,
  key: string,
  dependency: T
): void {
  const existing = dependencies.get(key);
  if (!existing || (existing.watchOnly === true && dependency.watchOnly !== true)) {
    dependencies.set(key, dependency);
  }
}
