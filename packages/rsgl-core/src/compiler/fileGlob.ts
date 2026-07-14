import * as fs from "node:fs";
import * as path from "node:path";
import { TextRange } from "../parser";
import type {
  EvaluationContext,
  RawGlobLimitExceeded,
  RawGlobLoadLimits,
  RawGlobLoadResult,
  RawGlobLoader
} from "./evaluate";
import { MAX_EVALUATION_ITEMS_PER_ALLOCATION } from "./evaluationItemBudget";

export interface RsglFileGlobLoaderOptions {
  fallbackFileName?: string;
  onError?: (code: string, message: string, range: TextRange) => void;
}

interface ResolvedGlobPattern {
  absolutePattern: string;
  outputBaseDirectory?: string;
}

const wildcardPattern = /[*?]/;

export function createFileGlobLoader(options: RsglFileGlobLoaderOptions = {}): RawGlobLoader {
  return (pattern, context, range, limits) => loadGlob(pattern, context, range, options, limits);
}

function loadGlob(
  pattern: string,
  context: EvaluationContext,
  range: TextRange,
  options: RsglFileGlobLoaderOptions,
  limits?: RawGlobLoadLimits
): RawGlobLoadResult {
  if (!pattern.trim()) {
    options.onError?.("rsgl.globInvalidPattern", "glob requires a non-empty pattern.", range);
    return undefined;
  }

  const resolved = resolveGlobPattern(pattern, context.sourceFile, options.fallbackFileName);
  const matcher = globToRegex(normalizeSlashes(resolved.absolutePattern));
  const collectionLimits = normalizeCollectionLimits(limits);
  const collected = wildcardPattern.test(resolved.absolutePattern)
    ? collectMatchingFiles(
      searchRootForPattern(resolved.absolutePattern),
      matcher,
      collectionLimits
    )
    : collectExactFile(resolved.absolutePattern, matcher, collectionLimits);
  if (!Array.isArray(collected)) {
    return collected;
  }
  const matches = collected.sort((left, right) =>
    normalizeSlashes(left).localeCompare(normalizeSlashes(right))
  );
  for (let index = 0; index < matches.length; index += 1) {
    matches[index] = formatGlobMatch(matches[index], resolved.outputBaseDirectory);
  }
  return matches;
}

function resolveGlobPattern(pattern: string, sourceFile: string | undefined, fallbackFileName: string | undefined): ResolvedGlobPattern {
  if (path.isAbsolute(pattern)) {
    const absolutePattern = path.normalize(pattern);
    const packRoot = findPackRoot(path.dirname(firstStaticPathSegment(absolutePattern)));
    return {
      absolutePattern,
      outputBaseDirectory: packRoot
    };
  }

  const baseFile = usableFileName(sourceFile) ?? usableFileName(fallbackFileName);
  const sourceDirectory = baseFile ? path.dirname(baseFile) : process.cwd();
  const normalizedPattern = normalizeSlashes(pattern);
  const baseDirectory = isPackRelativePattern(normalizedPattern)
    ? findPackRoot(sourceDirectory) ?? inferredPackRoot(sourceDirectory)
    : sourceDirectory;
  return {
    absolutePattern: path.resolve(baseDirectory, pattern),
    outputBaseDirectory: baseDirectory
  };
}

function isPackRelativePattern(pattern: string): boolean {
  return pattern === "pack.mcmeta" || pattern.startsWith("assets/");
}

function inferredPackRoot(sourceDirectory: string): string {
  return path.basename(sourceDirectory).toLowerCase() === "rsgl"
    ? path.dirname(sourceDirectory)
    : sourceDirectory;
}

function findPackRoot(startDirectory: string): string | undefined {
  let current = path.resolve(startDirectory);
  while (true) {
    if (fs.existsSync(path.join(current, "pack.mcmeta"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function firstStaticPathSegment(pattern: string): string {
  const normalized = normalizeSlashes(pattern);
  const wildcardIndex = normalized.search(wildcardPattern);
  if (wildcardIndex < 0) {
    return pattern;
  }
  const prefix = normalized.slice(0, wildcardIndex);
  const slashIndex = prefix.lastIndexOf("/");
  return slashIndex >= 0 ? path.normalize(prefix.slice(0, slashIndex)) : process.cwd();
}

function searchRootForPattern(pattern: string): string {
  const normalized = normalizeSlashes(pattern);
  const wildcardIndex = normalized.search(wildcardPattern);
  if (wildcardIndex < 0) {
    return path.dirname(pattern);
  }
  const prefix = normalized.slice(0, wildcardIndex);
  const slashIndex = prefix.lastIndexOf("/");
  return slashIndex >= 0 ? path.normalize(prefix.slice(0, slashIndex)) : process.cwd();
}

function collectMatchingFiles(
  directory: string,
  matcher: RegExp,
  limits: RawGlobLoadLimits
): string[] | RawGlobLimitExceeded {
  const pendingDirectories = [directory];
  const files: string[] = [];
  let visitedEntries = 0;

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop()!;
    let handle: fs.Dir;
    try {
      handle = fs.opendirSync(currentDirectory);
    } catch {
      continue;
    }

    try {
      let entry: fs.Dirent | null;
      while ((entry = handle.readSync()) !== null) {
        visitedEntries += 1;
        if (visitedEntries > limits.maxVisitedEntries) {
          return globLimitExceeded;
        }
        const fullPath = path.join(currentDirectory, entry.name);
        if (entry.isDirectory()) {
          pendingDirectories.push(fullPath);
        } else if (entry.isFile() && matcher.test(normalizeSlashes(fullPath))) {
          if (files.length >= limits.maxMatches) {
            return globLimitExceeded;
          }
          files.push(fullPath);
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  return files;
}

function collectExactFile(
  fileName: string,
  matcher: RegExp,
  limits: RawGlobLoadLimits
): string[] | RawGlobLimitExceeded {
  try {
    if (!fs.statSync(fileName).isFile()) {
      return [];
    }
  } catch {
    return [];
  }
  if (!matcher.test(normalizeSlashes(fileName))) {
    return [];
  }
  return limits.maxMatches >= 1 && limits.maxVisitedEntries >= 1
    ? [fileName]
    : globLimitExceeded;
}

function normalizeCollectionLimits(limits: RawGlobLoadLimits | undefined): RawGlobLoadLimits {
  return {
    maxMatches: normalizeCollectionLimit(limits?.maxMatches),
    maxVisitedEntries: normalizeCollectionLimit(limits?.maxVisitedEntries)
  };
}

function normalizeCollectionLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, MAX_EVALUATION_ITEMS_PER_ALLOCATION)
    : MAX_EVALUATION_ITEMS_PER_ALLOCATION;
}

const globLimitExceeded: RawGlobLimitExceeded = { kind: "limitExceeded" };

function globToRegex(pattern: string): RegExp {
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
  regex += "$";
  return new RegExp(regex);
}

function formatGlobMatch(fileName: string, outputBaseDirectory: string | undefined): string {
  if (outputBaseDirectory) {
    const relative = path.relative(outputBaseDirectory, fileName);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return normalizeSlashes(relative);
    }
  }
  return normalizeSlashes(path.resolve(fileName));
}

function usableFileName(fileName: string | undefined): string | undefined {
  if (!fileName || /^<[^>]+>$/.test(fileName)) {
    return undefined;
  }
  return path.resolve(fileName);
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function escapeRegex(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}
