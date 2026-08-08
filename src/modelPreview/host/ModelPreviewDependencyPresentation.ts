import type { PreviewDependency } from "../ir/PreviewDocument";

/** Resolution candidates remain tracked by the host but are not effective inputs worth showing. */
export function getDisplayedPreviewDependencies(
  dependencies: readonly PreviewDependency[]
): PreviewDependency[] {
  return dependencies.filter(dependency => dependency.watchOnly !== true);
}
