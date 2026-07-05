import * as fs from "node:fs";
import * as path from "node:path";
import { TextRange } from "../parser";
import { EvaluationContext, RawGlobLoader } from "./evaluate";

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
  return (pattern, context, range) => loadGlob(pattern, context, range, options);
}

function loadGlob(
  pattern: string,
  context: EvaluationContext,
  range: TextRange,
  options: RsglFileGlobLoaderOptions
): string[] | undefined {
  if (!pattern.trim()) {
    options.onError?.("rsgl.globInvalidPattern", "glob requires a non-empty pattern.", range);
    return undefined;
  }

  const resolved = resolveGlobPattern(pattern, context.sourceFile, options.fallbackFileName);
  const searchRoot = searchRootForPattern(resolved.absolutePattern);
  const matcher = globToRegex(normalizeSlashes(resolved.absolutePattern));
  const matches = collectFiles(searchRoot)
    .filter(fileName => matcher.test(normalizeSlashes(fileName)))
    .sort((left, right) => normalizeSlashes(left).localeCompare(normalizeSlashes(right)));

  return matches.map(fileName => formatGlobMatch(fileName, resolved.outputBaseDirectory));
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

function collectFiles(directory: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

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
