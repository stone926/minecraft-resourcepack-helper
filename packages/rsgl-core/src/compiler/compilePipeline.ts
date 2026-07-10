import * as path from "node:path";
import { RsglModule } from "../parser";
import { bindRsglModule, bindRsglProgram, RsglSourceFile } from "../semantic";
import type { RsglProgram } from "../semantic";
import { includeRsglStdlibSourceFiles } from "../stdlib";
import { RsglWorkspaceSourceCache } from "../workspaceSource";
import {
  createCompileGlobLoader,
  detectOutputConflicts,
  hasErrors,
  moduleSyntaxDiagnostics,
  normalizeFileName,
  selectProgramModels,
  semanticProgramMatchesFiles,
  withTargetPackFormat
} from "./compilerHelpers";
import {
  createCachedBaseDocumentLoader,
  createFileBaseDocumentLoader
} from "./base/loader";
import type { BaseDocumentLoader, CompileDependency } from "./base/types";
import { createRsglStdlibPreludeTemplates, RsglCompiler } from "./compiler";
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
  baseDocumentLoader?: BaseDocumentLoader;
  fileName?: string;
  namespace?: string;
  stdlibRoot?: string;
}

export interface RsglProgramCompileOptions extends RsglResourceValidationOptions {
  baseDocumentLoader?: BaseDocumentLoader;
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
    return { units: [], diagnostics: syntaxDiagnostics, dependencies: [] };
  }
  const fileName = options.fileName ?? "<anonymous>";
  const sourceFiles = includeRsglStdlibSourceFiles([{ fileName, module }], { stdlibRoot: options.stdlibRoot });
  if (sourceFiles.length > 1) {
    return compileRsglProgram(sourceFiles, { ...options, entryFileName: fileName });
  }

  const semanticModel = bindRsglModule(module, { fileName: options.fileName });
  const namespace = options.namespace ?? semanticModel.namespace ?? "minecraft";
  const loaderDiagnostics: RsglCompileDiagnostic[] = [];
  const baseDocumentLoader = createCachedBaseDocumentLoader(
    options.baseDocumentLoader ?? createFileBaseDocumentLoader({ fallbackFileName: fileName })
  );
  const globLoader = createCompileGlobLoader(options.fileName ?? "<anonymous>", loaderDiagnostics);
  const target = resolveTargetPackFormat([{ module, namespace }]);
  const environment = createStandaloneCompileEnvironment(
    semanticModel,
    namespace,
    { baseDocumentLoader, globLoader }
  );
  const compiler = new RsglCompiler(module, {
    fileName: options.fileName ?? "<anonymous>",
    namespace,
    environment,
    baseDocumentLoader,
    globLoader,
    targetPackFormat: target.targetPackFormat,
    stdlibRoot: options.stdlibRoot
  });
  const result = compiler.compile();
  const finished = finishCompilation(result.units, target.targetPackFormat, options, result.dependencies);
  return {
    units: finished.units,
    diagnostics: dedupeCompileDiagnostics([
      ...semanticModel.diagnostics.map(diagnostic => ({ ...diagnostic })),
      ...target.diagnostics,
      ...loaderDiagnostics,
      ...result.diagnostics,
      ...finished.diagnostics
    ]),
    dependencies: finished.dependencies
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
      dependencies: [],
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
    return { units: [], diagnostics: syntaxDiagnostics, dependencies: [] };
  }

  const program = semanticProgramMatchesFiles(options.semanticProgram, sourceFiles)
    ? options.semanticProgram
    : bindRsglProgram(sourceFiles, { stdlibRoot: options.stdlibRoot });
  const units: ResourceUnit[] = [];
  const dependencies: CompileDependency[] = [];
  const diagnostics: RsglCompileDiagnostic[] = [
    ...program.fileDiagnostics.map(diagnostic => ({ ...diagnostic }))
  ];
  const baseDocumentLoader = createCachedBaseDocumentLoader(
    options.baseDocumentLoader ?? createFileBaseDocumentLoader({ fallbackFileName: options.entryFileName })
  );
  const globLoader = createCompileGlobLoader(options.entryFileName ?? "<anonymous>", diagnostics);
  const environments = createProgramCompileEnvironments(program, options.namespace, { baseDocumentLoader, globLoader });
  const stdlibTemplates = createRsglStdlibPreludeTemplates(options.stdlibRoot);
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
      stdlibTemplates,
      externalTemplates: Array.from(environment.importedTemplates.values()),
      externalValues: mapToExternalValues(environment.importedValues),
      environment,
      baseDocumentLoader,
      globLoader,
      targetPackFormat: target.targetPackFormat,
      stdlibRoot: options.stdlibRoot
    });
    const result = compiler.compile();
    units.push(...result.units);
    diagnostics.push(...result.diagnostics);
    dependencies.push(...result.dependencies);
  }

  const finished = finishCompilation(units, target.targetPackFormat, options, dependencies);
  diagnostics.push(...target.diagnostics, ...finished.diagnostics);
  return {
    units: finished.units,
    diagnostics: dedupeCompileDiagnostics(diagnostics),
    dependencies: finished.dependencies
  };
}

/**
 * The semantic checker and the compile-time evaluator intentionally guard the
 * same rules (lambda arity, purity); when both fire for one defect they
 * produce byte-identical diagnostics. Exact duplicates carry no information,
 * so the merged result keeps the first occurrence. A diagnostic without a
 * fileName matches one with any fileName (single-module semantic diagnostics
 * are unattributed while evaluator diagnostics name their file).
 */
function dedupeCompileDiagnostics(diagnostics: RsglCompileDiagnostic[]): RsglCompileDiagnostic[] {
  const seen = new Map<string, RsglCompileDiagnostic[]>();
  const result: RsglCompileDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = [diagnostic.code, diagnostic.severity, diagnostic.range.start, diagnostic.range.end, diagnostic.message].join("\0");
    const matches = seen.get(key);
    if (matches?.some(existing => !existing.fileName || !diagnostic.fileName || existing.fileName === diagnostic.fileName)) {
      continue;
    }
    seen.set(key, [...(matches ?? []), diagnostic]);
    result.push(diagnostic);
  }
  return result;
}

function finishCompilation(
  units: ResourceUnit[],
  targetPackFormat: RsglTargetPackFormat | undefined,
  options: RsglResourceValidationOptions,
  dependencies: CompileDependency[] = []
): RsglCompileResult {
  const lowered = lowerItemUnitsForTarget(units, targetPackFormat);
  const merged = mergeResourceUnits(lowered.units);
  const validationOptions = withTargetPackFormat(options, targetPackFormat);
  return {
    units: merged.units,
    dependencies: dedupeCompileDependencies(dependencies),
    diagnostics: [
      ...lowered.diagnostics,
      ...merged.diagnostics,
      ...detectOutputConflicts(merged.units),
      ...validateResourceUnits(merged.units, validationOptions)
    ]
  };
}

function dedupeCompileDependencies(dependencies: CompileDependency[]): CompileDependency[] {
  const seen = new Set<string>();
  const result: CompileDependency[] = [];
  for (const dependency of dependencies) {
    const key = [
      normalizedDependencyPath(dependency.path),
      dependency.reason,
      normalizedDependencyPath(dependency.sourceFile),
      dependency.sourceRange.start,
      dependency.sourceRange.end
    ].join("\0");
    if (!seen.has(key)) {
      seen.add(key);
      result.push(dependency);
    }
  }
  return result;
}

function normalizedDependencyPath(fileName: string): string {
  if (/^<[^>]+>$/.test(fileName)) {
    return fileName;
  }
  const normalized = path.normalize(path.resolve(fileName));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
