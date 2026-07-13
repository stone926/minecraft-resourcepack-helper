import {
  createRsglWritePlan,
  compileRsglDirectory,
  compileRsglFile,
  compileRsglProgram,
  emitRsglFiles,
  type RsglEmittedFile,
  type RsglCompileDiagnostic,
  type RsglCompileResult,
  type CompileDependency,
  type RsglEmitOptions,
  writeRsglFiles,
  type RsglWritePlan,
  type RsglWritePlanOptions
} from "./compiler";
import type { RsglProgram, RsglSourceFile } from "./semantic";
import type {
  RsglCompileConfigurationOptions,
  RsglProgramCompileOptions,
  RsglResourceValidationOptions
} from "./compiler";

export interface RsglBuildOptions extends
  RsglResourceValidationOptions,
  RsglCompileConfigurationOptions,
  RsglEmitOptions,
  RsglWritePlanOptions {
  outputRoot: string;
}

export interface RsglBuildResult {
  plan?: RsglWritePlan;
  diagnostics: RsglCompileDiagnostic[];
  dependencies: CompileDependency[];
  cancelled?: boolean;
}

export interface RsglPreparedBuildResult {
  diagnostics: RsglCompileDiagnostic[];
  dependencies: CompileDependency[];
  files?: RsglEmittedFile[];
  cancelled?: boolean;
}

export function buildRsglResourcePack(entryFileName: string, options: RsglBuildOptions): RsglBuildResult {
  const compiled = prepareRsglResourcePackBuild(entryFileName, options);
  return writeCompiledRsglBuild(compiled, options);
}

export function prepareRsglResourcePackBuild(entryFileName: string, options: RsglBuildOptions): RsglPreparedBuildResult {
  return prepareCompiledRsglBuild(compileRsglFile(entryFileName, options), options);
}

export function buildRsglResourcePackDirectory(rootDirectory: string, options: RsglBuildOptions): RsglBuildResult {
  const compiled = prepareRsglResourcePackDirectoryBuild(rootDirectory, options);
  return writeCompiledRsglBuild(compiled, options);
}

export function prepareRsglResourcePackDirectoryBuild(rootDirectory: string, options: RsglBuildOptions): RsglPreparedBuildResult {
  return prepareCompiledRsglBuild(compileRsglDirectory(rootDirectory, options), options);
}

export interface RsglProgramBuildOptions extends RsglBuildOptions, Pick<RsglProgramCompileOptions, "entryFileName"> {
  sourceRoot?: string;
  semanticProgram?: RsglProgram;
}

export function buildRsglResourcePackProgram(files: RsglSourceFile[], options: RsglProgramBuildOptions): RsglBuildResult {
  const compiled = prepareRsglResourcePackProgramBuild(files, options);
  return writeCompiledRsglBuild(compiled, options);
}

export function prepareRsglResourcePackProgramBuild(
  files: RsglSourceFile[],
  options: RsglProgramBuildOptions
): RsglPreparedBuildResult {
  const result = compileRsglProgram(files, {
    ...options,
    entryFileName: options.entryFileName,
    semanticProgram: options.semanticProgram
  });
  return prepareCompiledRsglBuild(result, options);
}

export interface RsglBuildPreviewResult extends RsglBuildResult {
  preview?: string;
}

export interface RsglBuildPreviewFormatOptions {
  entryFileName?: string;
  sourceRoot?: string;
  maxDiffLinesPerFile?: number;
}

export function previewRsglResourcePackBuild(entryFileName: string, options: RsglBuildOptions): RsglBuildPreviewResult {
  const compiled = prepareRsglResourcePackBuild(entryFileName, options);
  return previewCompiledRsglBuild(compiled, options, { entryFileName });
}

export function previewRsglResourcePackDirectoryBuild(rootDirectory: string, options: RsglBuildOptions): RsglBuildPreviewResult {
  const compiled = prepareRsglResourcePackDirectoryBuild(rootDirectory, options);
  return previewCompiledRsglBuild(compiled, options, { sourceRoot: rootDirectory });
}

export function previewRsglResourcePackProgramBuild(files: RsglSourceFile[], options: RsglProgramBuildOptions): RsglBuildPreviewResult {
  const compiled = prepareRsglResourcePackProgramBuild(files, options);
  return previewCompiledRsglBuild(compiled, options, {
    entryFileName: options.entryFileName,
    sourceRoot: options.sourceRoot
  });
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
    ...(options.sourceRoot ? [`Source root: ${options.sourceRoot}`] : []),
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
      if (isCopyPlanEntry(entry)) {
        lines.push(`Binary copy from ${entry.copyFrom}`);
      } else {
        lines.push(...createPreviewDiffLines(entry.previousContent, entry.content, maxDiffLinesPerFile));
      }
      lines.push("```", "");
    }
  }
  return `${lines.join("\n")}\n`;
}

function isCopyPlanEntry(entry: RsglWritePlan["entries"][number]): entry is RsglWritePlan["entries"][number] & { copyFrom: string } {
  return "copyFrom" in entry;
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

function prepareCompiledRsglBuild(
  result: RsglCompileResult,
  options: RsglBuildOptions
): RsglPreparedBuildResult {
  if (isCancellationRequested(options)) {
    return { diagnostics: result.diagnostics, dependencies: result.dependencies, cancelled: true };
  }

  const blockingDiagnostics = result.diagnostics.filter(diagnostic => diagnostic.severity === "error");
  if (blockingDiagnostics.length > 0) {
    return {
      diagnostics: result.diagnostics,
      dependencies: result.dependencies
    };
  }

  const files = emitRsglFiles(result.units, {
    ...options,
    sourceMaps: options.sourceMaps ?? true,
    manifest: options.manifest ?? true
  });
  return isCancellationRequested(options)
    ? { diagnostics: result.diagnostics, dependencies: result.dependencies, cancelled: true }
    : { diagnostics: result.diagnostics, dependencies: result.dependencies, files };
}

function writeCompiledRsglBuild(
  compiled: RsglPreparedBuildResult,
  options: RsglBuildOptions
): RsglBuildResult {
  if (compiled.cancelled || isCancellationRequested(options)) {
    return { diagnostics: compiled.diagnostics, dependencies: compiled.dependencies, cancelled: true };
  }
  if (!compiled.files) {
    return {
      diagnostics: compiled.diagnostics,
      dependencies: compiled.dependencies
    };
  }

  const plan = writeRsglFiles(compiled.files, options.outputRoot, options);
  return isCancellationRequested(options)
    ? { diagnostics: compiled.diagnostics, dependencies: compiled.dependencies, cancelled: true }
    : { diagnostics: compiled.diagnostics, dependencies: compiled.dependencies, plan };
}

function previewCompiledRsglBuild(
  compiled: RsglPreparedBuildResult,
  options: RsglBuildOptions,
  previewOptions: RsglBuildPreviewFormatOptions
): RsglBuildPreviewResult {
  if (compiled.cancelled || isCancellationRequested(options)) {
    return { diagnostics: compiled.diagnostics, dependencies: compiled.dependencies, cancelled: true };
  }
  if (!compiled.files) {
    return {
      diagnostics: compiled.diagnostics,
      dependencies: compiled.dependencies
    };
  }

  const plan = createRsglWritePlan(compiled.files, options.outputRoot, {
    ...options,
    includePreviousContent: true
  });
  if (isCancellationRequested(options)) {
    return { diagnostics: compiled.diagnostics, dependencies: compiled.dependencies, cancelled: true };
  }
  return {
    diagnostics: compiled.diagnostics,
    dependencies: compiled.dependencies,
    plan,
    preview: formatRsglBuildPreview(plan, previewOptions)
  };
}

function isCancellationRequested(options: RsglBuildOptions): boolean {
  return options.isCancellationRequested?.() ?? false;
}
