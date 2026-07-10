import type { Dirent } from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { lm, type LocalizedMessage } from "../i18n/messages";
import type { PngMetadata } from "../../packages/mc-assets/src";

export { readPngMetadata, type PngMetadata } from "../../packages/mc-assets/src";

export type NonJsonIssueSeverity = "warning" | "information";

export interface FileResourceIssue {
  filePath: string;
  message: LocalizedMessage;
  severity: NonJsonIssueSeverity;
}

export interface TextResourceIssue {
  line: number;
  startCharacter: number;
  endCharacter: number;
  message: LocalizedMessage;
  severity: NonJsonIssueSeverity;
}

export interface PackImageResourceHost {
  pathExists(fileName: string): boolean;
  readDirectoryEntries(directory: string): readonly Dirent[] | null;
  readPngMetadata(fileName: string): PngMetadata | null;
}

const hiddenSplashHash = 125780783;
const validFormattingCodePattern = /§[0-9a-fk-or]/gi;
const invalidFormattingCodePattern = /§(?![0-9a-fk-or])/gi;

export function getPackImageResourceIssues(packRoot: string, host: PackImageResourceHost): FileResourceIssue[] {
  return [
    ...getPackPngIssues(packRoot, host),
    ...getColormapIssues(packRoot, host)
  ];
}

export function getTextResourceIssues(fileName: string, text: string, bytes?: Uint8Array): TextResourceIssue[] {
  const textResourceKind = getTextResourceKind(fileName);
  if (!textResourceKind) {
    return [];
  }

  const issues: TextResourceIssue[] = [];
  if (bytes && !isValidUtf8(bytes)) {
    issues.push({
      line: 0,
      startCharacter: 0,
      endCharacter: getLineEnd(text, 0),
      message: lm("Text resource files must be valid UTF-8."),
      severity: "warning"
    });
  }

  const lines = splitLines(text);
  lines.forEach((line, index) => {
    const effectiveLine = textResourceKind === "splashes" ? line.trim() : line;
    pushInvalidFormattingCodeIssues(issues, line, index);
    pushLongLineIssue(issues, effectiveLine, line, index);

    if (textResourceKind === "splashes" && javaStringHashCode(effectiveLine) === hiddenSplashHash) {
      issues.push({
        line: index,
        startCharacter: 0,
        endCharacter: line.length,
        message: lm("This splashes.txt line has Java hashCode 125780783 and will never be displayed."),
        severity: "information"
      });
    }

    if (textResourceKind === "endText" || textResourceKind === "postcredits") {
      pushPlayerNamePlaceholderIssues(issues, line, index);
    }
  });

  return issues;
}

export function javaStringHashCode(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
  }

  return hash;
}

function getPackPngIssues(packRoot: string, host: PackImageResourceHost): FileResourceIssue[] {
  const packPngPath = path.join(packRoot, "pack.png");
  if (!host.pathExists(packPngPath)) {
    return [{
      filePath: packPngPath,
      message: lm("pack.png is missing; Minecraft will use the default unknown pack icon."),
      severity: "information"
    }];
  }

  const metadata = host.readPngMetadata(packPngPath);
  return metadata ? [] : [{
    filePath: packPngPath,
    message: lm("pack.png must be a valid PNG file."),
    severity: "warning"
  }];
}

function getColormapIssues(packRoot: string, host: PackImageResourceHost): FileResourceIssue[] {
  const assetsRoot = path.join(packRoot, "assets");
  const issues: FileResourceIssue[] = [];
  for (const namespace of host.readDirectoryEntries(assetsRoot) ?? []) {
    if (!namespace.isDirectory()) {
      continue;
    }

    const colormapRoot = path.join(assetsRoot, namespace.name, "textures", "colormap");
    for (const entry of host.readDirectoryEntries(colormapRoot) ?? []) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".png") {
        continue;
      }

      const filePath = path.join(colormapRoot, entry.name);
      const metadata = host.readPngMetadata(filePath);
      if (!metadata) {
        issues.push({
          filePath,
          message: lm("Colormap texture must be a valid PNG file."),
          severity: "warning"
        });
      } else if (metadata.width !== 256 || metadata.height !== 256) {
        issues.push({
          filePath,
          message: lm("Colormap texture must be 256x256 pixels; current size is {0}x{1}.", metadata.width, metadata.height),
          severity: "warning"
        });
      }
    }
  }

  return issues;
}

function getTextResourceKind(fileName: string): "splashes" | "endText" | "postcredits" | null {
  if (/[\\/]assets[\\/][^\\/]+[\\/]texts[\\/]splashes\.txt$/i.test(fileName)) {
    return "splashes";
  }

  if (/[\\/]assets[\\/][^\\/]+[\\/]texts[\\/]end\.txt$/i.test(fileName)) {
    return "endText";
  }

  if (/[\\/]assets[\\/][^\\/]+[\\/]texts[\\/]postcredits\.txt$/i.test(fileName)) {
    return "postcredits";
  }

  return null;
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

function pushInvalidFormattingCodeIssues(issues: TextResourceIssue[], line: string, lineIndex: number): void {
  for (const match of line.matchAll(invalidFormattingCodePattern)) {
    const start = match.index ?? 0;
    issues.push({
      line: lineIndex,
      startCharacter: start,
      endCharacter: Math.min(line.length, start + 2),
      message: lm("Unsupported Minecraft formatting code; use § followed by 0-9, a-f, k-o, or r."),
      severity: "warning"
    });
  }
}

function pushLongLineIssue(issues: TextResourceIssue[], effectiveLine: string, rawLine: string, lineIndex: number): void {
  const estimatedWidth = estimateMinecraftTextWidth(effectiveLine);
  if (estimatedWidth <= 256) {
    return;
  }

  issues.push({
    line: lineIndex,
    startCharacter: 0,
    endCharacter: rawLine.length,
    message: lm("Text line estimated width is {0}px; Minecraft wraps lines wider than 256px.", estimatedWidth),
    severity: "information"
  });
}

function pushPlayerNamePlaceholderIssues(issues: TextResourceIssue[], line: string, lineIndex: number): void {
  for (const match of line.matchAll(/playername/gi)) {
    if (match[0] === "PLAYERNAME") {
      continue;
    }

    const start = match.index ?? 0;
    issues.push({
      line: lineIndex,
      startCharacter: start,
      endCharacter: start + match[0].length,
      message: lm("Only uppercase PLAYERNAME is replaced with the current player name."),
      severity: "warning"
    });
  }
}

function estimateMinecraftTextWidth(value: string): number {
  let width = 0;
  const visibleText = value.replace(validFormattingCodePattern, "");
  for (const character of visibleText) {
    if (character === " ") {
      width += 4;
    } else if (character === "\t") {
      width += 24;
    } else {
      width += 6;
    }
  }

  return width;
}

function getLineEnd(text: string, lineIndex: number): number {
  return splitLines(text)[lineIndex]?.length ?? 0;
}
