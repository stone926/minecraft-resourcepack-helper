import * as fs from "node:fs";
import * as path from "node:path";
import { TextRange } from "../parser";
import { EvaluationContext, EvaluationValue, RawJsonLoader } from "./evaluate";

export interface RsglFileRawJsonLoaderOptions {
  fallbackFileName?: string;
  onError?: (code: string, message: string, range: TextRange) => void;
}

export function createFileRawJsonLoader(options: RsglFileRawJsonLoaderOptions = {}): RawJsonLoader {
  return (request, context, range) => loadRawJsonFile(request, context, range, options);
}

function loadRawJsonFile(
  request: string,
  context: EvaluationContext,
  range: TextRange,
  options: RsglFileRawJsonLoaderOptions
): EvaluationValue {
  if (!request.trim()) {
    options.onError?.("rsgl.rawJsonInvalidPath", "raw_json requires a non-empty path.", range);
    return undefined;
  }

  const resolvedPath = resolveRawJsonPath(request, context.sourceFile, options.fallbackFileName);
  let content: string;
  try {
    content = fs.readFileSync(resolvedPath, "utf8");
  } catch (error) {
    options.onError?.(
      "rsgl.rawJsonLoadFailed",
      `Unable to load raw JSON '${request}': ${errorMessage(error)}.`,
      range
    );
    return undefined;
  }

  try {
    return JSON.parse(content) as EvaluationValue;
  } catch (error) {
    options.onError?.(
      "rsgl.rawJsonParseFailed",
      `Unable to parse raw JSON '${request}': ${errorMessage(error)}.`,
      range
    );
    return undefined;
  }
}

function resolveRawJsonPath(request: string, sourceFile: string | undefined, fallbackFileName: string | undefined): string {
  if (path.isAbsolute(request)) {
    return path.normalize(request);
  }
  const baseFile = usableFileName(sourceFile) ?? usableFileName(fallbackFileName);
  const baseDirectory = baseFile ? path.dirname(baseFile) : process.cwd();
  return path.resolve(baseDirectory, request);
}

function usableFileName(fileName: string | undefined): string | undefined {
  if (!fileName || /^<[^>]+>$/.test(fileName)) {
    return undefined;
  }
  return path.resolve(fileName);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
