import * as path from "node:path";
import { normalizePathKey } from "../../mc-assets/src";
import {
  compileDependencyPathContains,
  compileDependencyPatternMatchesPath,
  compileDependencyPatternStructurallyMatchesPath,
  compileDependencyWatchPatternKey,
  normalizeCompileDependencyWatchPattern,
  type CompileDependencyWatchPattern
} from "../../rsgl-core/src/compiler/compileDependencies";
import type { CompileDependency } from "../../rsgl-core/src/compiler/base/types";

export type RsglDependencyWatchPattern = CompileDependencyWatchPattern;

export interface RsglDocumentDependencies {
  exactPaths: ReadonlySet<string>;
  patterns: readonly RsglDependencyWatchPattern[];
}

export type RsglDocumentDependencyEntry = ReadonlySet<string> | RsglDocumentDependencies;
export type RsglDocumentDependencyIndex = ReadonlyMap<string, RsglDocumentDependencyEntry>;

/** Builds the exact-path and glob-pattern dependency selectors for one document. */
export function documentDependenciesForCompile(
  dependencies: readonly CompileDependency[],
  additionalWatchPaths: readonly string[]
): RsglDocumentDependencies {
  const exactPaths = dependencyPathsForDocument(dependencies, additionalWatchPaths);
  const patterns = new Map<string, RsglDependencyWatchPattern>();
  for (const dependency of dependencies) {
    if (!dependency.globPattern) {
      continue;
    }
    const watchPattern = normalizeCompileDependencyWatchPattern({
      basePath: dependency.path,
      pattern: dependency.globPattern
    });
    patterns.set(compileDependencyWatchPatternKey(watchPattern), watchPattern);
  }
  return { exactPaths, patterns: [...patterns.values()] };
}

/** Returns true when a document's complete exact/pattern selector set is unchanged. */
export function documentDependenciesEqual(
  left: RsglDocumentDependencies | undefined,
  right: RsglDocumentDependencies
): boolean {
  if (!left || left.exactPaths.size !== right.exactPaths.size || left.patterns.length !== right.patterns.length) {
    return false;
  }
  for (const exactPath of left.exactPaths) {
    if (!right.exactPaths.has(exactPath)) {
      return false;
    }
  }
  const rightPatterns = new Set(right.patterns.map(compileDependencyWatchPatternKey));
  return left.patterns.every(pattern => rightPatterns.has(compileDependencyWatchPatternKey(pattern)));
}

/** Returns true when a compile discovers at least one selector not watched before it started. */
export function documentDependenciesExpanded(
  previous: RsglDocumentDependencies | undefined,
  next: RsglDocumentDependencies
): boolean {
  if (!previous) {
    return next.exactPaths.size > 0 || next.patterns.length > 0;
  }
  for (const exactPath of next.exactPaths) {
    if (!previous.exactPaths.has(exactPath)) {
      return true;
    }
  }
  const previousPatterns = new Set(previous.patterns.map(compileDependencyWatchPatternKey));
  return next.patterns.some(pattern =>
    !previousPatterns.has(compileDependencyWatchPatternKey(pattern))
  );
}

/** Returns open-document ids whose last compile depends on a changed path. */
export function documentsDependingOnPath(
  dependenciesByDocument: RsglDocumentDependencyIndex,
  changedPath: string
): string[] {
  const normalizedChangedPath = normalizeDependencyPath(changedPath);
  const result: string[] = [];
  for (const [documentId, dependencies] of dependenciesByDocument) {
    const exactPaths = isDocumentDependencies(dependencies)
      ? dependencies.exactPaths
      : dependencies;
    if (
      exactPaths.has(normalizedChangedPath)
      || (isDocumentDependencies(dependencies)
        && dependencies.patterns.some(pattern =>
          compileDependencyPatternMatchesPath(pattern, changedPath)
        ))
    ) {
      result.push(documentId);
    }
  }
  return result;
}

/**
 * Returns documents whose exact path lies below a changed ancestor or whose
 * glob can gain/lose matches through a changed directory prefix.
 */
export function documentsStructurallyDependingOnPath(
  dependenciesByDocument: RsglDocumentDependencyIndex,
  changedPath: string
): string[] {
  const normalizedChangedPath = normalizeDependencyPath(changedPath);
  const result: string[] = [];
  for (const [documentId, dependencies] of dependenciesByDocument) {
    const exactPaths = isDocumentDependencies(dependencies)
      ? dependencies.exactPaths
      : dependencies;
    const exactAffected = [...exactPaths].some(exactPath =>
      exactPath !== normalizedChangedPath
      && compileDependencyPathContains(changedPath, exactPath)
    );
    const patternAffected = isDocumentDependencies(dependencies)
      && dependencies.patterns.some(pattern =>
        compileDependencyPatternStructurallyMatchesPath(pattern, changedPath)
      );
    if (exactAffected || patternAffected) {
      result.push(documentId);
    }
  }
  return result;
}

/**
 * Expands a structural directory event to the concrete cache keys discovered
 * below it without discarding unrelated workspace state.
 */
export function dependencyInvalidationPathsForStructuralChange(
  dependenciesByDocument: RsglDocumentDependencyIndex,
  changedPath: string
): string[] {
  const normalizedChangedPath = normalizeDependencyPath(changedPath);
  const paths = new Set<string>();
  for (const dependencies of dependenciesByDocument.values()) {
    const exactPaths = isDocumentDependencies(dependencies)
      ? dependencies.exactPaths
      : dependencies;
    for (const exactPath of exactPaths) {
      if (
        exactPath !== normalizedChangedPath
        && compileDependencyPathContains(changedPath, exactPath)
      ) {
        paths.add(normalizeDependencyPath(exactPath));
      }
    }
    if (!isDocumentDependencies(dependencies)) {
      continue;
    }
    for (const pattern of dependencies.patterns) {
      if (compileDependencyPatternStructurallyMatchesPath(pattern, changedPath)) {
        paths.add(normalizeDependencyPath(pattern.basePath));
      }
    }
  }
  return [...paths].sort();
}

/** Merges exact compile dependencies with project/import watch candidates. */
export function dependencyPathsForDocument(
  dependencies: readonly CompileDependency[],
  additionalWatchPaths: readonly string[]
): Set<string> {
  return new Set([
    ...dependencies
      .filter(dependency => !dependency.globPattern)
      .map(dependency => normalizeDependencyPath(dependency.path)),
    ...additionalWatchPaths.map(normalizeDependencyPath)
  ]);
}

/** Returns the stable, deduplicated exact-path union for all open documents. */
export function dependencyPathsForDocuments(
  dependenciesByDocument: RsglDocumentDependencyIndex
): string[] {
  const paths = new Set<string>();
  for (const dependencies of dependenciesByDocument.values()) {
    const exactPaths = isDocumentDependencies(dependencies)
      ? dependencies.exactPaths
      : dependencies;
    for (const dependency of exactPaths) {
      paths.add(normalizeDependencyPath(dependency));
    }
  }
  return [...paths].sort();
}

/**
 * Returns exact content watchers after applying pattern coverage per document.
 * Coverage is intentionally resolved before the cross-document union so a
 * broad glob owned by one document cannot suppress another document's exact
 * dependency on the same path.
 */
export function requiredExactWatchPathsForDocuments(
  dependenciesByDocument: RsglDocumentDependencyIndex
): string[] {
  const paths = new Set<string>();
  for (const dependencies of dependenciesByDocument.values()) {
    if (!isDocumentDependencies(dependencies)) {
      for (const exactPath of dependencies) {
        paths.add(normalizeDependencyPath(exactPath));
      }
      continue;
    }
    for (const exactPath of dependencies.exactPaths) {
      if (!dependencies.patterns.some(pattern =>
        compileDependencyPatternMatchesPath(pattern, exactPath)
      )) {
        paths.add(normalizeDependencyPath(exactPath));
      }
    }
  }
  return [...paths].sort();
}

/** Returns the stable, deduplicated glob-pattern union for all open documents. */
export function dependencyPatternsForDocuments(
  dependenciesByDocument: RsglDocumentDependencyIndex
): RsglDependencyWatchPattern[] {
  const patterns = new Map<string, RsglDependencyWatchPattern>();
  for (const dependencies of dependenciesByDocument.values()) {
    if (!isDocumentDependencies(dependencies)) {
      continue;
    }
    for (const pattern of dependencies.patterns) {
      const normalized = normalizeCompileDependencyWatchPattern(pattern);
      patterns.set(compileDependencyWatchPatternKey(normalized), normalized);
    }
  }
  return [...patterns.values()].sort((left, right) =>
    compileDependencyWatchPatternKey(left).localeCompare(compileDependencyWatchPatternKey(right))
  );
}

/** Normalizes a filesystem path for stable identity comparisons. */
export function normalizeDependencyPath(fileName: string): string {
  return normalizePathKey(path.resolve(fileName));
}

function isDocumentDependencies(
  value: RsglDocumentDependencyEntry
): value is RsglDocumentDependencies {
  return "exactPaths" in value;
}
