import * as path from "node:path";
import {
  isRsglPathInsideOrEqual,
  resolvedRsglPathKey,
  resolveRsglPath
} from "../pathIdentity";
import type { CompileDependency } from "./base/types";

export interface CompileDependencyWatchPattern {
  basePath: string;
  pattern: string;
}

/** Returns the targeted watcher selector encoded by a pattern dependency. */
export function compileDependencyWatchPattern(
  dependency: CompileDependency
): CompileDependencyWatchPattern | undefined {
  return dependency.globPattern
    ? normalizeCompileDependencyWatchPattern({
        basePath: dependency.path,
        pattern: dependency.globPattern
      })
    : undefined;
}

/** Matches either an exact dependency or its relative glob selector. */
export function compileDependencyMatchesPath(
  dependency: Pick<CompileDependency, "path" | "globPattern">,
  candidatePath: string
): boolean {
  if (!dependency.globPattern) {
    return resolvedRsglPathKey(dependency.path) === resolvedRsglPathKey(candidatePath);
  }
  return compileDependencyPatternMatchesPath({
    basePath: dependency.path,
    pattern: dependency.globPattern
  }, candidatePath);
}

/** Normalizes a relative pattern using the same path identity policy as RSGL. */
export function normalizeCompileDependencyWatchPattern(
  pattern: CompileDependencyWatchPattern
): CompileDependencyWatchPattern {
  return {
    basePath: resolveRsglPath(pattern.basePath),
    pattern: normalizePatternIdentity(pattern.pattern)
  };
}

export function compileDependencyPatternMatchesPath(
  pattern: CompileDependencyWatchPattern,
  candidatePath: string
): boolean {
  const normalized = normalizeCompileDependencyWatchPattern(pattern);
  const relative = path.relative(normalized.basePath, path.resolve(candidatePath));
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    return false;
  }
  return globPatternRegex(normalized.pattern).test(normalizePatternIdentity(relative));
}

/**
 * Returns the directory-prefix selectors whose create/delete events can add or
 * remove matches from a glob. For example, `**\/*.json` requires a structural
 * `**` watcher, while `*.json` has no descendant-directory selector.
 */
export function compileDependencyStructuralWatchPatterns(
  pattern: CompileDependencyWatchPattern
): CompileDependencyWatchPattern[] {
  const normalized = normalizeCompileDependencyWatchPattern(pattern);
  const segments = normalized.pattern.split("/");
  const prefixes = new Map<string, CompileDependencyWatchPattern>();
  for (let length = 1; length < segments.length; length++) {
    const prefix = normalizeCompileDependencyWatchPattern({
      basePath: normalized.basePath,
      pattern: segments.slice(0, length).join("/")
    });
    prefixes.set(compileDependencyWatchPatternKey(prefix), prefix);
  }
  const recursiveSegmentIndex = segments.findIndex(segment => segment.includes("**"));
  if (recursiveSegmentIndex >= 0) {
    const recursiveSegment = segments[recursiveSegmentIndex];
    const recursivePrefix = normalizeCompileDependencyWatchPattern({
      basePath: normalized.basePath,
      pattern: [
        ...segments.slice(0, recursiveSegmentIndex),
        `${recursiveSegment.slice(0, recursiveSegment.indexOf("**"))}**`
      ].join("/")
    });
    prefixes.set(compileDependencyWatchPatternKey(recursivePrefix), recursivePrefix);
  }
  return [...prefixes.values()];
}

/** Returns true when a directory event can structurally change glob matches. */
export function compileDependencyPatternStructurallyMatchesPath(
  pattern: CompileDependencyWatchPattern,
  candidatePath: string
): boolean {
  const normalized = normalizeCompileDependencyWatchPattern(pattern);
  if (compileDependencyPathContains(candidatePath, normalized.basePath)) {
    return true;
  }
  return compileDependencyStructuralWatchPatterns(normalized).some(prefix =>
    compileDependencyPatternMatchesPath(prefix, candidatePath)
  );
}

/** Uses RSGL path identity to test whether `candidate` is inside `root`. */
export function compileDependencyPathContains(root: string, candidate: string): boolean {
  return isRsglPathInsideOrEqual(candidate, root);
}

/**
 * Anchors a selector at the nearest existing ancestor and folds missing static
 * segments into the relative pattern, preserving future create events.
 */
export function rebaseCompileDependencyWatchPattern(
  pattern: CompileDependencyWatchPattern,
  pathExists: (fileName: string) => boolean
): CompileDependencyWatchPattern {
  const normalized = normalizeCompileDependencyWatchPattern(pattern);
  let basePath = normalized.basePath;
  const missingSegments: string[] = [];
  while (!pathExists(basePath)) {
    const parent = path.dirname(basePath);
    if (parent === basePath) {
      break;
    }
    missingSegments.unshift(path.basename(basePath));
    basePath = parent;
  }
  return {
    basePath,
    pattern: [...missingSegments, normalized.pattern].join("/")
  };
}

/** Returns a concrete matching path used for one post-install verification. */
export function compileDependencyPatternProbePath(
  pattern: CompileDependencyWatchPattern
): string {
  const normalized = normalizeCompileDependencyWatchPattern(pattern);
  const probe = normalized.pattern
    .replaceAll("**", "__rsgl_watch__")
    .replaceAll("*", "__rsgl_watch__")
    .replaceAll("?", "x");
  return path.join(normalized.basePath, ...probe.split("/"));
}

export function compileDependencyWatchPatternKey(
  pattern: CompileDependencyWatchPattern
): string {
  const normalized = normalizeCompileDependencyWatchPattern(pattern);
  return `${resolvedRsglPathKey(normalized.basePath)}\0${normalized.pattern}`;
}

function globPatternRegex(pattern: string): RegExp {
  let regex = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index++;
        }
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += escapeRegex(char);
    }
  }
  return new RegExp(`${regex}$`);
}

function escapeRegex(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function normalizePatternIdentity(value: string): string {
  const identityRoot = path.resolve(".rsgl-watch-pattern-identity");
  const candidate = path.join(identityRoot, ...value.replaceAll("\\", "/").split("/"));
  return path.relative(
    resolvedRsglPathKey(identityRoot),
    resolvedRsglPathKey(candidate)
  ).replaceAll("\\", "/");
}
