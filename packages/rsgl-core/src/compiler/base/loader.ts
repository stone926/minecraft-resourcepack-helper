import * as fs from "node:fs";
import * as path from "node:path";
import {
  evaluate,
  parse,
  type MemberNode,
  type ValueNode
} from "@humanwhocodes/momoa";
import type { TextRange } from "../../parser";
import type { JsonValue } from "../ir";
import { appendGeneratedPath } from "../sourcePaths";
import {
  BaseDocumentLoadError,
  type BaseDocument,
  type BaseDocumentLoader
} from "./types";

export interface FileBaseDocumentLoaderOptions {
  fallbackFileName?: string;
  readFile?: (fileName: string) => string;
}

/** Creates the default synchronous JSON base-document loader. */
export function createFileBaseDocumentLoader(
  options: FileBaseDocumentLoaderOptions = {}
): BaseDocumentLoader {
  const readFile = options.readFile ?? (fileName => fs.readFileSync(fileName, "utf8"));
  return {
    load(request, sourceFile) {
      const resolvedPath = resolveBaseDocumentPath(request, sourceFile, options.fallbackFileName);
      let text: string;
      try {
        text = readFile(resolvedPath);
      } catch (error) {
        throw new BaseDocumentLoadError(
          "rsgl.baseLoadFailed",
          `Unable to load base JSON '${request}': ${errorMessage(error)}.`,
          { cause: error }
        );
      }

      let document;
      try {
        document = parse(text, { mode: "json", ranges: true });
      } catch (error) {
        throw new BaseDocumentLoadError(
          "rsgl.baseParseFailed",
          `Unable to parse base JSON '${request}': ${errorMessage(error)}.`,
          { cause: error }
        );
      }

      const sourceRanges = collectJsonPointerSourceRanges(document.body);
      return {
        content: evaluate(document) as JsonValue,
        sourceFile: resolvedPath,
        sourceRange: nodeRange(document.body),
        sourceRanges,
        dependencies: []
      };
    }
  };
}

/**
 * Wraps a loader with a per-compilation cache. Successful documents and typed
 * failures are both cached so repeated imports never reread the same file.
 */
export function createCachedBaseDocumentLoader(loader: BaseDocumentLoader): BaseDocumentLoader {
  const cache = new Map<string, { document: BaseDocument } | { error: unknown }>();
  return {
    load(request, sourceFile, sourceRange) {
      const resolvedPath = resolveBaseDocumentPath(request, sourceFile);
      const key = normalizeCacheKey(resolvedPath);
      const cached = cache.get(key);
      if (cached) {
        if ("error" in cached) {
          throw cached.error;
        }
        return cached.document;
      }

      try {
        const document = loader.load(resolvedPath, sourceFile, sourceRange);
        cache.set(key, { document });
        return document;
      } catch (error) {
        cache.set(key, { error });
        throw error;
      }
    }
  };
}

/** Resolves a base path relative to the RSGL source file that requested it. */
export function resolveBaseDocumentPath(
  request: string,
  sourceFile?: string,
  fallbackFileName?: string
): string {
  if (path.isAbsolute(request)) {
    return path.normalize(request);
  }
  const baseFile = usableFileName(sourceFile) ?? usableFileName(fallbackFileName);
  const baseDirectory = baseFile ? path.dirname(baseFile) : process.cwd();
  return path.resolve(baseDirectory, request);
}

function collectJsonPointerSourceRanges(root: ValueNode): ReadonlyMap<string, TextRange> {
  const ranges = new Map<string, TextRange>();
  collectNodeRanges(root, "", ranges);
  return ranges;
}

function collectNodeRanges(node: ValueNode, pointer: string, ranges: Map<string, TextRange>): void {
  ranges.set(pointer, nodeRange(node));
  if (node.type === "Object") {
    for (const member of node.members) {
      const childPointer = appendGeneratedPath(pointer, memberName(member));
      collectNodeRanges(member.value, childPointer, ranges);
      ranges.set(childPointer, nodeRange(member));
    }
  } else if (node.type === "Array") {
    node.elements.forEach((element, index) => {
      const childPointer = appendGeneratedPath(pointer, String(index));
      collectNodeRanges(element.value, childPointer, ranges);
      ranges.set(childPointer, nodeRange(element));
    });
  }
}

function memberName(member: MemberNode): string {
  return member.name.type === "String" ? member.name.value : member.name.name;
}

function nodeRange(node: { range?: [number, number] }): TextRange {
  const [start, end] = node.range ?? [0, 0];
  return { start, end };
}

function usableFileName(fileName: string | undefined): string | undefined {
  if (!fileName || /^<[^>]+>$/.test(fileName)) {
    return undefined;
  }
  return path.resolve(fileName);
}

function normalizeCacheKey(fileName: string): string {
  const normalized = path.normalize(path.resolve(fileName));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
