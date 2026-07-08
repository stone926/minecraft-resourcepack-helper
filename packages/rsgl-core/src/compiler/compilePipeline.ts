import * as path from "node:path";
import { RsglModule } from "../parser";
import { bindRsglModule, bindRsglProgram, RsglSourceFile } from "../semantic";
import type { RsglProgram } from "../semantic";
import { includeRsglStdlibSourceFiles } from "../stdlib";
import { RsglWorkspaceSourceCache } from "../workspaceSource";
import {
  createCompileGlobLoader,
  createCompileRawJsonLoader,
  detectOutputConflicts,
  hasErrors,
  moduleSyntaxDiagnostics,
  normalizeFileName,
  selectProgramModels,
  semanticProgramMatchesFiles,
  withTargetPackFormat
} from "./compilerHelpers";
import { RsglCompiler } from "./compiler";
import {
  createProgramCompileEnvironments,
  createStandaloneCompileEnvironment,
  mapToExternalValues
} from "./environment";
import { ResourceUnit, RsglCompileDiagnostic, RsglCompileResult } from "./ir";
import { lowerItemUnitsForTarget } from "./itemLegacyBackend";
import { mergeResourceUnits } from "./merge";
import { resolveTargetPackFormat, RsglTargetPackFormat } from "./target";
import { RsglResourceValidationOptions, validateResourceUnits } from "./validation";

export interface RsglCompileOptions extends RsglResourceValidationOptions {
  fileName?: string;
  namespace?: string;
  stdlibRoot?: string;
}

export interface RsglProgramCompileOptions extends RsglResourceValidationOptions {
  entryFileName?: string;
  namespace?: string;
  semanticProgram?: RsglProgram;
  stdlibRoot?: string;
}

export interface RsglFileLoadOptions {
  encoding?: BufferEncoding;
}

export interface RsglFileCompileOptions extends Omit<RsglProgramCompileOptions, "entryFileName">, RsglFileLoadOptions { }

export interface RsglDirectoryCompileOptions extends Omit<RsglProgramCompileOptions, "entryFileName">, RsglFileLoadOptions { }

export function compileRsglModule(module: RsglModule, options: RsglCompileOptions = {}): RsglCompileResult {
  const syntaxDiagnostics = moduleSyntaxDiagnostics(module, options.fileName);
  if (hasErrors(syntaxDiagnostics)) {
    return { units: [], diagnostics: syntaxDiagnostics };
  }
  const fileName = options.fileName ?? "<anonymous>";
  const sourceFiles = includeRsglStdlibSourceFiles([{ fileName, module }], { stdlibRoot: options.stdlibRoot });
  if (sourceFiles.length > 1) {
    return compileRsglProgram(sourceFiles, { ...options, entryFileName: fileName });
  }

  const semanticModel = bindRsglModule(module, { fileName: options.fileName });
  const namespace = options.namespace ?? semanticModel.namespace ?? "minecraft";
  const rawJsonDiagnostics: RsglCompileDiagnostic[] = [];
  const rawJsonLoader = createCompileRawJsonLoader(options.fileName ?? "<anonymous>", rawJsonDiagnostics);
  const globLoader = createCompileGlobLoader(options.fileName ?? "<anonymous>", rawJsonDiagnostics);
  const target = resolveTargetPackFormat([{ module, namespace }]);
  const environment = createStandaloneCompileEnvironment(
    semanticModel,
    namespace,
    { rawJsonLoader, globLoader }
  );
  const compiler = new RsglCompiler(module, {
    fileName: options.fileName ?? "<anonymous>",
    namespace,
    environment,
    rawJsonLoader,
    globLoader,
    targetPackFormat: target.targetPackFormat,
    stdlibRoot: options.stdlibRoot
  });
  const result = compiler.compile();
  const finished = finishCompilation(result.units, target.targetPackFormat, options);
  return {
    units: finished.units,
    diagnostics: [
      ...semanticModel.diagnostics.map(diagnostic => ({ ...diagnostic })),
      ...target.diagnostics,
      ...rawJsonDiagnostics,
      ...result.diagnostics,
      ...finished.diagnostics
    ]
  };
}

export function compileRsglFile(entryFileName: string, options: RsglFileCompileOptions = {}): RsglCompileResult {
  const { encoding, ...compileOptions } = options;
  const resolvedEntryFileName = path.resolve(entryFileName);
  const files = loadRsglSourceFilesFromFile(resolvedEntryFileName, { encoding });
  return compileRsglProgram(files, { ...compileOptions, entryFileName: resolvedEntryFileName });
}

export function compileRsglDirectory(rootDirectory: string, options: RsglDirectoryCompileOptions = {}): RsglCompileResult {
  const { encoding, ...compileOptions } = options;
  const resolvedRootDirectory = path.resolve(rootDirectory);
  const files = loadRsglSourceFilesFromDirectory(resolvedRootDirectory, { encoding });
  if (files.length === 0) {
    return {
      units: [],
      diagnostics: [{
        code: "rsgl.compileMissingSource",
        message: `No RSGL source files found in ${resolvedRootDirectory}.`,
        range: { start: 0, end: 1 },
        severity: "error",
        fileName: resolvedRootDirectory
      }]
    };
  }
  return compileRsglProgram(files, compileOptions);
}

export function loadRsglSourceFilesFromFile(entryFileName: string, options: RsglFileLoadOptions = {}): RsglSourceFile[] {
  return new RsglWorkspaceSourceCache(options).loadProgramFromEntry(entryFileName);
}

export function loadRsglSourceFilesFromDirectory(rootDirectory: string, options: RsglFileLoadOptions = {}): RsglSourceFile[] {
  return new RsglWorkspaceSourceCache(options).loadProgramFromDirectory(rootDirectory);
}

export function compileRsglProgram(files: RsglSourceFile[], options: RsglProgramCompileOptions = {}): RsglCompileResult {
  const sourceFiles = includeRsglStdlibSourceFiles(files, { stdlibRoot: options.stdlibRoot });
  const syntaxDiagnostics = sourceFiles.flatMap(file => moduleSyntaxDiagnostics(file.module, file.fileName));
  if (hasErrors(syntaxDiagnostics)) {
    return { units: [], diagnostics: syntaxDiagnostics };
  }

  const program = semanticProgramMatchesFiles(options.semanticProgram, sourceFiles)
    ? options.semanticProgram
    : bindRsglProgram(sourceFiles, { stdlibRoot: options.stdlibRoot });
  const units: ResourceUnit[] = [];
  const diagnostics: RsglCompileDiagnostic[] = [
    ...program.fileDiagnostics.map(diagnostic => ({ ...diagnostic }))
  ];
  const rawJsonLoader = createCompileRawJsonLoader(options.entryFileName ?? "<anonymous>", diagnostics);
  const globLoader = createCompileGlobLoader(options.entryFileName ?? "<anonymous>", diagnostics);
  const environments = createProgramCompileEnvironments(program, options.namespace, { rawJsonLoader, globLoader });
  const selectedModels = selectProgramModels(program, options.entryFileName);
  const target = resolveTargetPackFormat(selectedModels.map(model => ({
    module: model.module,
    namespace: options.namespace ?? model.namespace ?? "minecraft"
  })));

  if (options.entryFileName && selectedModels.length === 0) {
    diagnostics.push({
      code: "rsgl.compileMissingEntry",
      message: `RSGL entry file not found: ${options.entryFileName}.`,
      range: { start: 0, end: 1 },
      severity: "error",
      fileName: options.entryFileName
    });
  }

  for (const model of selectedModels) {
    const namespace = options.namespace ?? model.namespace ?? "minecraft";
    const environment = environments.get(normalizeFileName(model.fileName))
      ?? createStandaloneCompileEnvironment(model, namespace);
    const compiler = new RsglCompiler(model.module, {
      fileName: model.fileName,
      namespace,
      externalTemplates: Array.from(environment.importedTemplates.values()),
      externalValues: mapToExternalValues(environment.importedValues),
      environment,
      rawJsonLoader,
      globLoader,
      targetPackFormat: target.targetPackFormat,
      stdlibRoot: options.stdlibRoot
    });
    const result = compiler.compile();
    units.push(...result.units);
    diagnostics.push(...result.diagnostics);
  }

  const finished = finishCompilation(units, target.targetPackFormat, options);
  diagnostics.push(...target.diagnostics, ...finished.diagnostics);
  return { units: finished.units, diagnostics };
}

function finishCompilation(
  units: ResourceUnit[],
  targetPackFormat: RsglTargetPackFormat | undefined,
  options: RsglResourceValidationOptions
): RsglCompileResult {
  const lowered = lowerItemUnitsForTarget(units, targetPackFormat);
  const merged = mergeResourceUnits(lowered.units);
  const validationOptions = withTargetPackFormat(options, targetPackFormat);
  return {
    units: merged.units,
    diagnostics: [
      ...lowered.diagnostics,
      ...merged.diagnostics,
      ...detectOutputConflicts(merged.units),
      ...validateResourceUnits(merged.units, validationOptions)
    ]
  };
}
