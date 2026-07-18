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

export function previewRsglResourcePackBuild(entryFileName: string, options: RsglBuildOptions): RsglBuildPreviewResult {
  const compiled = prepareRsglResourcePackBuild(entryFileName, options);
  return previewCompiledRsglBuild(compiled, options, {
    entryFileName,
    messages: options.previewMessages
  });
}

export function previewRsglResourcePackDirectoryBuild(rootDirectory: string, options: RsglBuildOptions): RsglBuildPreviewResult {
  const compiled = prepareRsglResourcePackDirectoryBuild(rootDirectory, options);
  return previewCompiledRsglBuild(compiled, options, {
    sourceRoot: rootDirectory,
    messages: options.previewMessages
  });
}

export function previewRsglResourcePackProgramBuild(files: RsglSourceFile[], options: RsglProgramBuildOptions): RsglBuildPreviewResult {
  const compiled = prepareRsglResourcePackProgramBuild(files, options);
  return previewCompiledRsglBuild(compiled, options, {
    entryFileName: options.entryFileName,
    sourceRoot: options.sourceRoot,
    messages: options.previewMessages
  });
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
