import {
  createRsglWritePlan,
  compileRsglFile,
  emitRsglFiles,
  type RsglEmittedFile,
  type RsglCompileDiagnostic,
  type RsglEmitOptions,
  writeRsglFiles,
  type RsglWritePlan,
  type RsglWritePlanOptions
} from "./compiler";
import type { RsglResourceValidationOptions } from "./compiler";

export interface RsglBuildOptions extends RsglResourceValidationOptions, RsglEmitOptions, RsglWritePlanOptions {
  outputRoot: string;
}

export interface RsglBuildResult {
  plan?: RsglWritePlan;
  diagnostics: RsglCompileDiagnostic[];
}

export function buildRsglResourcePack(entryFileName: string, options: RsglBuildOptions): RsglBuildResult {
  const compiled = compileRsglBuildFiles(entryFileName, options);
  if (!compiled.files) {
    return {
      diagnostics: compiled.diagnostics
    };
  }

  return {
    diagnostics: compiled.diagnostics,
    plan: writeRsglFiles(compiled.files, options.outputRoot, options)
  };
}

export interface RsglBuildPreviewResult extends RsglBuildResult {
  preview?: string;
}

export interface RsglBuildPreviewFormatOptions {
  entryFileName?: string;
  maxDiffLinesPerFile?: number;
}

export function previewRsglResourcePackBuild(entryFileName: string, options: RsglBuildOptions): RsglBuildPreviewResult {
  const compiled = compileRsglBuildFiles(entryFileName, options);
  if (!compiled.files) {
    return {
      diagnostics: compiled.diagnostics
    };
  }

  const plan = createRsglWritePlan(compiled.files, options.outputRoot, {
    ...options,
    includePreviousContent: true
  });
  return {
    diagnostics: compiled.diagnostics,
    plan,
    preview: formatRsglBuildPreview(plan, { entryFileName })
  };
}

export function formatRsglBuildPreview(
  plan: RsglWritePlan,
  options: RsglBuildPreviewFormatOptions = {}
): string {
  const maxDiffLinesPerFile = options.maxDiffLinesPerFile ?? 80;
  const lines = [
    "# RSGL Build Preview",
    "",
    ...(options.entryFileName ? [`Entry: ${options.entryFileName}`] : []),
    `Output root: ${plan.outputRoot}`,
    `Summary: ${plan.summary.create} create, ${plan.summary.update} update, ${plan.summary.unchanged} unchanged`,
    "",
    "## Planned Changes",
    ""
  ];
  const changedEntries = plan.entries.filter(entry => entry.status !== "unchanged");
  if (changedEntries.length === 0) {
    lines.push("No file changes.");
  } else {
    for (const entry of changedEntries) {
      const diff = entry.diff ? ` (+${entry.diff.addedLines} -${entry.diff.removedLines})` : "";
      lines.push(`- ${entry.status}: ${entry.outputPath}${diff}`);
    }
    lines.push("", "## Diff Preview", "");
    for (const entry of changedEntries) {
      lines.push(`### ${entry.outputPath}`, "", "```diff");
      lines.push(...createPreviewDiffLines(entry.previousContent, entry.content, maxDiffLinesPerFile));
      lines.push("```", "");
    }
  }
  return `${lines.join("\n")}\n`;
}

function createPreviewDiffLines(previousContent: string | undefined, nextContent: string, maxLines: number): string[] {
  if (previousContent === undefined) {
    return truncateDiffLines(splitPreviewLines(nextContent).map(line => `+${line}`), maxLines);
  }

  const previousLines = splitPreviewLines(previousContent);
  const nextLines = splitPreviewLines(nextContent);
  const commonPrefixLength = countPreviewCommonPrefix(previousLines, nextLines);
  const commonSuffixLength = countPreviewCommonSuffix(previousLines, nextLines, commonPrefixLength);
  const before = previousLines.slice(Math.max(0, commonPrefixLength - 3), commonPrefixLength)
    .map(line => ` ${line}`);
  const removed = previousLines.slice(commonPrefixLength, previousLines.length - commonSuffixLength)
    .map(line => `-${line}`);
  const added = nextLines.slice(commonPrefixLength, nextLines.length - commonSuffixLength)
    .map(line => `+${line}`);
  const after = nextLines.slice(nextLines.length - commonSuffixLength, Math.min(nextLines.length, nextLines.length - commonSuffixLength + 3))
    .map(line => ` ${line}`);
  return truncateDiffLines([...before, ...removed, ...added, ...after], maxLines);
}

function truncateDiffLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }
  const kept = Math.max(0, maxLines - 1);
  return [
    ...lines.slice(0, kept),
    `... ${lines.length - kept} more diff line(s) omitted`
  ];
}

function splitPreviewLines(value: string): string[] {
  return value.length === 0 ? [] : value.split(/\r?\n/);
}

function countPreviewCommonPrefix(left: string[], right: string[]): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index++;
  }
  return index;
}

function countPreviewCommonSuffix(left: string[], right: string[], prefixLength: number): number {
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

function compileRsglBuildFiles(
  entryFileName: string,
  options: RsglBuildOptions
): { diagnostics: RsglCompileDiagnostic[]; files?: RsglEmittedFile[] } {
  const result = compileRsglFile(entryFileName, options);
  const blockingDiagnostics = result.diagnostics.filter(diagnostic => diagnostic.severity === "error");
  if (blockingDiagnostics.length > 0) {
    return {
      diagnostics: result.diagnostics
    };
  }

  return {
    diagnostics: result.diagnostics,
    files: emitRsglFiles(result.units, {
      ...options,
      sourceMaps: options.sourceMaps ?? true,
      manifest: options.manifest ?? true
    })
  };
}
