import * as fs from "node:fs";
import * as path from "node:path";
import { isRsglPathInsideOrEqual } from "../pathIdentity";
import { RsglCopyEmittedFile, RsglEmittedFile } from "./emit";
import {
  RsglCopySourceReadError,
  RsglOutputFileReadError,
  RsglUnsafeOutputPathError
} from "./writeErrors";

export type RsglWriteStatus = "create" | "update" | "unchanged";

export interface RsglWriteSummary {
  create: number;
  update: number;
  unchanged: number;
}

export interface RsglWriteDiff {
  addedLines: number;
  removedLines: number;
}

export type RsglWritePlanEntry = RsglEmittedFile & {
  absolutePath: string;
  status: RsglWriteStatus;
  previousContent?: string;
  diff?: RsglWriteDiff;
};

export interface RsglWritePlan {
  outputRoot: string;
  entries: RsglWritePlanEntry[];
  summary: RsglWriteSummary;
}

export interface RsglWritePlanOptions {
  encoding?: BufferEncoding;
  includePreviousContent?: boolean;
  isCancellationRequested?: () => boolean;
}

export function createRsglWritePlan(
  files: RsglEmittedFile[],
  outputRoot: string,
  options: RsglWritePlanOptions = {}
): RsglWritePlan {
  const encoding = options.encoding ?? "utf8";
  const root = path.resolve(outputRoot);
  const entries = files.map(file => createPlanEntry(file, root, encoding, options.includePreviousContent ?? false));
  return {
    outputRoot: root,
    entries,
    summary: entries.reduce<RsglWriteSummary>((summary, entry) => {
      summary[entry.status]++;
      return summary;
    }, { create: 0, update: 0, unchanged: 0 })
  };
}

export function writeRsglFiles(
  files: RsglEmittedFile[],
  outputRoot: string,
  options: RsglWritePlanOptions = {}
): RsglWritePlan {
  const plan = createRsglWritePlan(files, outputRoot, options);
  const encoding = options.encoding ?? "utf8";
  for (const entry of plan.entries) {
    if (options.isCancellationRequested?.()) {
      break;
    }
    if (entry.status === "unchanged") {
      continue;
    }
    fs.mkdirSync(path.dirname(entry.absolutePath), { recursive: true });
    if (isCopyFile(entry)) {
      fs.copyFileSync(entry.copyFrom, entry.absolutePath);
    } else {
      fs.writeFileSync(entry.absolutePath, entry.content, encoding);
    }
  }
  return plan;
}

function createPlanEntry(
  file: RsglEmittedFile,
  outputRoot: string,
  encoding: BufferEncoding,
  includePreviousContent: boolean
): RsglWritePlanEntry {
  const absolutePath = resolveRsglOutputPath(outputRoot, file.outputPath);
  if (isCopyFile(file)) {
    const previousContent = readExistingOutputFile(absolutePath);
    const nextContent = readCopySource(file.copyFrom);
    const status = previousContent === undefined
      ? "create"
      : Buffer.compare(previousContent, nextContent) === 0 ? "unchanged" : "update";
    return {
      ...file,
      absolutePath,
      status
    };
  }

  const previousContent = readExistingOutputFile(absolutePath, encoding);
  const status = previousContent === undefined
    ? "create"
    : previousContent === file.content ? "unchanged" : "update";

  return {
    ...file,
    absolutePath,
    status,
    previousContent: includePreviousContent ? previousContent : undefined,
    diff: previousContent !== undefined && previousContent !== file.content
      ? createRsglLineDiff(previousContent, file.content)
      : undefined
  };
}

function isCopyFile(file: RsglEmittedFile): file is RsglCopyEmittedFile {
  return "copyFrom" in file;
}

export function resolveRsglOutputPath(outputRoot: string, outputPath: string): string {
  if (path.isAbsolute(outputPath)) {
    throw new RsglUnsafeOutputPathError(outputPath);
  }
  const normalizedOutput = outputPath.replace(/[\\/]+/g, path.sep);
  const resolved = path.resolve(outputRoot, normalizedOutput);
  if (!isRsglPathInsideOrEqual(resolved, outputRoot)) {
    throw new RsglUnsafeOutputPathError(outputPath);
  }
  return resolved;
}

function readCopySource(fileName: string): Buffer {
  try {
    return fs.readFileSync(fileName);
  } catch (error) {
    throw new RsglCopySourceReadError(fileName, { cause: error });
  }
}

function readExistingOutputFile(fileName: string): Buffer | undefined;
function readExistingOutputFile(fileName: string, encoding: BufferEncoding): string | undefined;
function readExistingOutputFile(
  fileName: string,
  encoding?: BufferEncoding
): Buffer | string | undefined {
  if (!fs.existsSync(fileName)) {
    return undefined;
  }
  try {
    return encoding ? fs.readFileSync(fileName, encoding) : fs.readFileSync(fileName);
  } catch (error) {
    throw new RsglOutputFileReadError(fileName, { cause: error });
  }
}

export function createRsglLineDiff(previous: string, next: string): RsglWriteDiff {
  const previousLines = splitLines(previous);
  const nextLines = splitLines(next);
  const commonPrefixLength = countCommonPrefix(previousLines, nextLines);
  const commonSuffixLength = countCommonSuffix(previousLines, nextLines, commonPrefixLength);
  return {
    removedLines: Math.max(0, previousLines.length - commonPrefixLength - commonSuffixLength),
    addedLines: Math.max(0, nextLines.length - commonPrefixLength - commonSuffixLength)
  };
}

function splitLines(value: string): string[] {
  return value.length === 0 ? [] : value.split(/\r?\n/);
}

function countCommonPrefix(left: string[], right: string[]): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index++;
  }
  return index;
}

function countCommonSuffix(left: string[], right: string[], prefixLength: number): number {
  let count = 0;
  while (
    count + prefixLength < left.length &&
    count + prefixLength < right.length &&
    left[left.length - count - 1] === right[right.length - count - 1]
  ) {
    count++;
  }
  return count;
}
