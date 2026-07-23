import * as path from "node:path";
import {
  createRsglMaterializationProject,
  compileRsglDirectory,
  compileRsglFile,
  compileRsglProgram,
  emitRsglFiles,
  previewRsglMaterializationTransactionSync,
  runRsglMaterializationTransactionSync,
  type RsglCompileDiagnostic,
  type RsglCompileResult,
  type CompileDependency,
  type RsglEmittedFile,
  type RsglEmitOptions,
  type RsglMaterializationPreview,
  type RsglMaterializationProject,
  type RsglMaterializationTransactionResult,
  type RsglWritePlan,
  type RsglWritePlanOptions
} from "./compiler";
import type { RsglProgram, RsglSourceFile } from "./semantic";
import type {
  RsglCompileConfigurationOptions,
  RsglProgramCompileOptions,
  RsglResourceValidationOptions
} from "./compiler";
import {
  formatRsglBuildPreview,
  type RsglBuildPreviewFormatOptions,
  type RsglBuildPreviewMessages
} from "./buildPreview";

export {
  defaultRsglBuildPreviewMessages,
  formatRsglBuildPreview,
  type RsglBuildPreviewFormatOptions,
  type RsglBuildPreviewMessages
} from "./buildPreview";

export interface RsglBuildOptions extends
  RsglResourceValidationOptions,
  RsglCompileConfigurationOptions,
  RsglEmitOptions,
  RsglWritePlanOptions {
  outputRoot: string;
  previewMessages?: RsglBuildPreviewMessages;
  /** Canonical host/project-package identity; fallback is derived for standalone callers. */
  materializationProject?: RsglMaterializationProject;
  /** Native compile source root used to serialize portable provenance. */
  materializationSourceRoot?: string;
  /** Explicitly adopt byte-identical unowned outputs into this project's manifest. */
  adoptUnownedIdentical?: boolean;
}

export interface RsglBuildResult {
  plan?: RsglWritePlan;
  materialization?: RsglMaterializationTransactionResult;
  materializationPreview?: RsglMaterializationPreview;
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
  return writeCompiledRsglBuild(compiled, options, entryFileName);
}

export function prepareRsglResourcePackBuild(entryFileName: string, options: RsglBuildOptions): RsglPreparedBuildResult {
  return prepareCompiledRsglBuild(compileRsglFile(entryFileName, options), options);
}

export function buildRsglResourcePackDirectory(rootDirectory: string, options: RsglBuildOptions): RsglBuildResult {
  const compiled = prepareRsglResourcePackDirectoryBuild(rootDirectory, options);
  return writeCompiledRsglBuild(compiled, options, rootDirectory);
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
  return writeCompiledRsglBuild(compiled, options, programSourceIdentity(files, options));
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

export function previewRsglResourcePackBuild(entryFileName: string, options: RsglBuildOptions): RsglBuildPreviewResult {
  const compiled = prepareRsglResourcePackBuild(entryFileName, options);
  return previewCompiledRsglBuild(compiled, options, {
    entryFileName,
    messages: options.previewMessages
  }, entryFileName);
}

export function previewRsglResourcePackDirectoryBuild(rootDirectory: string, options: RsglBuildOptions): RsglBuildPreviewResult {
  const compiled = prepareRsglResourcePackDirectoryBuild(rootDirectory, options);
  return previewCompiledRsglBuild(compiled, options, {
    sourceRoot: rootDirectory,
    messages: options.previewMessages
  }, rootDirectory);
}

export function previewRsglResourcePackProgramBuild(files: RsglSourceFile[], options: RsglProgramBuildOptions): RsglBuildPreviewResult {
  const compiled = prepareRsglResourcePackProgramBuild(files, options);
  return previewCompiledRsglBuild(compiled, options, {
    entryFileName: options.entryFileName,
    sourceRoot: options.sourceRoot,
    messages: options.previewMessages
  }, programSourceIdentity(files, options));
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
  options: RsglBuildOptions,
  sourceIdentity: string
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

  const materialization = runRsglMaterializationTransactionSync({
    files: compiled.files,
    outputRoot: options.outputRoot,
    project: options.materializationProject ?? createRsglMaterializationProject(
      materializationSourceRoot(options, sourceIdentity),
      options.outputRoot
    ),
    sourceRootPath: materializationSourceRoot(options, sourceIdentity),
    adoptUnownedIdentical: options.adoptUnownedIdentical,
    isCancellationRequested: options.isCancellationRequested
  });
  const diagnostics = [
    ...compiled.diagnostics,
    ...createRsglMaterializationDiagnostics(materialization)
  ];
  return materialization.status === "cancelled"
    ? { diagnostics, dependencies: compiled.dependencies, cancelled: true, materialization }
    : {
      diagnostics,
      dependencies: compiled.dependencies,
      plan: materialization.preview.writePlan,
      materialization
    };
}

function previewCompiledRsglBuild(
  compiled: RsglPreparedBuildResult,
  options: RsglBuildOptions,
  previewOptions: RsglBuildPreviewFormatOptions,
  sourceIdentity: string
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

  const materializationPreview = previewRsglMaterializationTransactionSync({
    files: compiled.files,
    outputRoot: options.outputRoot,
    project: options.materializationProject ?? createRsglMaterializationProject(
      materializationSourceRoot(options, sourceIdentity),
      options.outputRoot
    ),
    sourceRootPath: materializationSourceRoot(options, sourceIdentity),
    adoptUnownedIdentical: options.adoptUnownedIdentical,
    isCancellationRequested: options.isCancellationRequested
  });
  if (isCancellationRequested(options)) {
    return { diagnostics: compiled.diagnostics, dependencies: compiled.dependencies, cancelled: true };
  }
  return {
    diagnostics: [
      ...compiled.diagnostics,
      ...createRsglMaterializationPreviewDiagnostics(materializationPreview)
    ],
    dependencies: compiled.dependencies,
    plan: materializationPreview.writePlan,
    materializationPreview,
    preview: formatMaterializationPreview(materializationPreview, previewOptions)
  };
}

export function createRsglMaterializationDiagnostics(
  materialization: RsglMaterializationTransactionResult
): RsglCompileDiagnostic[] {
  const diagnostics = createRsglMaterializationPreviewDiagnostics(materialization.preview);
  if (materialization.failure) {
    diagnostics.push({
      code: materialization.status === "partial"
        ? "rsgl.materializationPartial"
        : "rsgl.materializationFailed",
      severity: "error",
      message: materialization.failure.message,
      range: { start: 0, end: 0 }
    });
  }
  return diagnostics;
}

export function createRsglMaterializationPreviewDiagnostics(
  preview: RsglMaterializationPreview
): RsglCompileDiagnostic[] {
  const diagnostics: RsglCompileDiagnostic[] = [];
  for (const entry of preview.ownershipPlan.writes) {
    if (entry.action === "conflict") {
      diagnostics.push({
        code: "rsgl.materializationConflict",
        severity: "error",
        message: `Materialization conflict at '${entry.output.outputPath}' (${entry.conflictReason ?? "unknown"}).`,
        range: { start: 0, end: 0 }
      });
    }
  }
  for (const entry of preview.ownershipPlan.stale) {
    if (entry.action === "preserve") {
      diagnostics.push({
        code: "rsgl.materializationStalePreserved",
        severity: "warning",
        message: `Preserved stale output '${entry.previous.outputPath}' (${entry.preserveReason ?? "unknown"}).`,
        range: { start: 0, end: 0 }
      });
    }
  }
  return diagnostics;
}

function formatMaterializationPreview(
  preview: RsglMaterializationPreview,
  options: RsglBuildPreviewFormatOptions
): string {
  const lines = [formatRsglBuildPreview(preview.writePlan, options).trimEnd()];
  const conflicts = preview.ownershipPlan.writes.filter(entry => entry.action === "conflict");
  if (conflicts.length > 0) {
    lines.push("", "## Conflicts", "");
    for (const entry of conflicts) {
      lines.push(`- conflict: ${entry.output.outputPath} (${entry.conflictReason ?? "unknown"})`);
    }
  }
  const adoptions = preview.ownershipPlan.writes.filter(entry => entry.action === "adopt");
  if (adoptions.length > 0) {
    lines.push("", "## Ownership Adoption", "");
    for (const entry of adoptions) {
      lines.push(`- adopt identical: ${entry.output.outputPath}`);
    }
  }
  if (preview.deletes.length > 0) {
    lines.push("", "## Stale Output Cleanup", "");
    for (const entry of preview.deletes) {
      const detail = entry.preserveReason ? ` (${entry.preserveReason})` : "";
      lines.push(`- ${entry.status}: ${entry.outputPath}${detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function isCancellationRequested(options: RsglBuildOptions): boolean {
  return options.isCancellationRequested?.() ?? false;
}

function programSourceIdentity(files: readonly RsglSourceFile[], options: RsglProgramBuildOptions): string {
  return options.sourceRoot ?? options.entryFileName ?? files[0]?.fileName ?? options.outputRoot;
}

function materializationSourceRoot(options: RsglBuildOptions, sourceIdentity: string): string {
  if (options.materializationSourceRoot) {
    return options.materializationSourceRoot;
  }
  return sourceIdentity.toLowerCase().endsWith(".rsgl")
    ? path.dirname(sourceIdentity)
    : sourceIdentity;
}
