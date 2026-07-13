import * as path from "node:path";
import { RsglModule, type ExternDeclNode, type TopLevelStatementNode } from "../parser";
import {
  parseExternResourcePattern,
  type RsglExternDeclaration,
  type RsglGlobalExternConfigEntry
} from "../externDeclarations";
import { getExternResourceKind } from "../resourceKinds";
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
  selectProgramTargetModels,
  semanticProgramMatchesFiles,
  withTargetPackFormat
} from "./compilerHelpers";
import {
  createCachedBaseDocumentLoader,
  createFileBaseDocumentLoader
} from "./base/loader";
import type { BaseDocumentLoader, CompileDependency } from "./base/types";
import {
  effectiveNamespace,
  resolveRsglCompileConfiguration,
  type RsglCompileConfigurationOptions
} from "./compileConfiguration";
import { createRsglStdlibPreludeTemplates, RsglCompiler } from "./compiler";
import {
  createProgramCompileEnvironments,
  createStandaloneCompileEnvironment,
  mapToExternalValues
} from "./environment";
import { ResourceUnit, RsglCompileDiagnostic, RsglCompileResult } from "./ir";
import { lowerItemUnitsForTarget } from "./itemLegacyBackend";
import { mergeResourceUnits } from "./merge";
import { createExternalResource } from "./templates";
import { resolveTargetPackFormat, RsglTargetPackFormat } from "./target";
import {
  type RsglExternalResourceUsage,
  canonicalizeAndValidateResourceUnits,
  RsglResourceValidationOptions
} from "./validation";

export interface RsglCompileOptions extends RsglResourceValidationOptions, RsglCompileConfigurationOptions {
  baseDocumentLoader?: BaseDocumentLoader;
  fileName?: string;
  stdlibRoot?: string;
}

export interface RsglProgramCompileOptions extends RsglResourceValidationOptions, RsglCompileConfigurationOptions {
  baseDocumentLoader?: BaseDocumentLoader;
  entryFileName?: string;
  semanticProgram?: RsglProgram;
  stdlibRoot?: string;
}

export interface RsglFileLoadOptions {
  encoding?: BufferEncoding;
}

export interface RsglFileCompileOptions extends Omit<RsglProgramCompileOptions, "entryFileName">, RsglFileLoadOptions { }

export interface RsglDirectoryCompileOptions extends Omit<RsglProgramCompileOptions, "entryFileName">, RsglFileLoadOptions { }

export function compileRsglModule(module: RsglModule, options: RsglCompileOptions = {}): RsglCompileResult {
  const configuration = resolveRsglCompileConfiguration(options);
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
  const namespace = effectiveNamespace(semanticModel.namespace, configuration);
  const loaderDiagnostics: RsglCompileDiagnostic[] = [];
  const baseDocumentLoader = createCachedBaseDocumentLoader(
    options.baseDocumentLoader ?? createFileBaseDocumentLoader({ fallbackFileName: fileName })
  );
  const globLoader = createCompileGlobLoader(options.fileName ?? "<anonymous>", loaderDiagnostics);
  const target = resolveTargetPackFormat(
    [{ module, namespace, fileName: options.fileName }],
    configuration.projectTarget
  );
  const environment = createStandaloneCompileEnvironment(
    semanticModel,
    namespace,
    { baseDocumentLoader, globLoader }
  );
  const compiler = new RsglCompiler(module, {
    fileName: options.fileName ?? "<anonymous>",
    namespace,
    stdlibTemplates: createRsglStdlibPreludeTemplates(options.stdlibRoot, configuration),
    environment,
    baseDocumentLoader,
    globLoader,
    targetPackFormat: target.targetPackFormat,
    maxEvaluationItems: configuration.maxEvaluationItems,
    stdlibRoot: options.stdlibRoot
  });
  const result = compiler.compile();
  const externs = collectExternDeclarations([{ fileName, module }], options.globalExterns, options.externDeclarations);
  const finished = finishCompilation(
    result.units,
    target.targetPackFormat,
    { ...options, externDeclarations: externs.declarations },
    result.dependencies
  );
  return {
    units: finished.units,
    diagnostics: dedupeCompileDiagnostics([
      ...semanticModel.diagnostics.map(diagnostic => ({ ...diagnostic })),
      ...externs.diagnostics,
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
  const configuration = resolveRsglCompileConfiguration(options);
  const sourceFiles = includeRsglStdlibSourceFiles(files, { stdlibRoot: options.stdlibRoot });
  const syntaxDiagnostics = sourceFiles.flatMap(file => moduleSyntaxDiagnostics(file.module, file.fileName));
  if (hasErrors(syntaxDiagnostics)) {
    return { units: [], diagnostics: syntaxDiagnostics, dependencies: [] };
  }

  const program = semanticProgramMatchesFiles(
    options.semanticProgram,
    sourceFiles,
    configuration.semanticFingerprint
  )
    ? options.semanticProgram
    : bindRsglProgram(sourceFiles, {
      stdlibRoot: options.stdlibRoot,
      semanticConfigurationFingerprint: configuration.semanticFingerprint
    });
  const units: ResourceUnit[] = [];
  const dependencies: CompileDependency[] = [];
  const diagnostics: RsglCompileDiagnostic[] = [
    ...program.fileDiagnostics.map(diagnostic => ({ ...diagnostic }))
  ];
  const baseDocumentLoader = createCachedBaseDocumentLoader(
    options.baseDocumentLoader ?? createFileBaseDocumentLoader({ fallbackFileName: options.entryFileName })
  );
  const globLoader = createCompileGlobLoader(options.entryFileName ?? "<anonymous>", diagnostics);
  const environments = createProgramCompileEnvironments(program, configuration, { baseDocumentLoader, globLoader });
  const externs = collectExternDeclarations(sourceFiles, options.globalExterns, options.externDeclarations);
  diagnostics.push(...externs.diagnostics);
  const stdlibTemplates = createRsglStdlibPreludeTemplates(options.stdlibRoot, configuration);
  const selectedModels = selectProgramModels(program, options.entryFileName);
  const targetModels = selectProgramTargetModels(program, options.entryFileName);
  const target = resolveTargetPackFormat(targetModels.map(model => ({
    module: model.module,
    namespace: effectiveNamespace(model.namespace, configuration),
    fileName: model.fileName
  })), configuration.projectTarget);

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
    const namespace = effectiveNamespace(model.namespace, configuration);
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
      maxEvaluationItems: configuration.maxEvaluationItems,
      stdlibRoot: options.stdlibRoot
    });
    const result = compiler.compile();
    units.push(...result.units);
    diagnostics.push(...result.diagnostics);
    dependencies.push(...result.dependencies);
  }

  const finished = finishCompilation(
    units,
    target.targetPackFormat,
    { ...options, externDeclarations: externs.declarations },
    dependencies
  );
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
  const externalUnits = new Map<string, ResourceUnit>();
  const externalDependencies: CompileDependency[] = [];
  const validationOptions = withTargetPackFormat({
    ...options,
    onExternResourceUsed: usage => {
      options.onExternResourceUsed?.(usage);
      recordExternalUsage(externalUnits, usage);
      if (usage.resolvedPath) {
        externalDependencies.push({
          path: usage.resolvedPath,
          reason: "extern",
          sourceFile: usage.sourceFile,
          sourceRange: usage.range
        });
      }
    }
  }, targetPackFormat);
  const validationDiagnostics = canonicalizeAndValidateResourceUnits(merged.units, validationOptions);
  return {
    units: [...merged.units, ...externalUnits.values()],
    dependencies: dedupeCompileDependencies([...dependencies, ...externalDependencies]),
    diagnostics: [
      ...lowered.diagnostics,
      ...merged.diagnostics,
      ...detectOutputConflicts(merged.units),
      ...validationDiagnostics
    ]
  };
}

function recordExternalUsage(
  units: Map<string, ResourceUnit>,
  usage: RsglExternalResourceUsage
): void {
  const key = [usage.source, usage.resourceKind, usage.id].join("\0");
  const existing = units.get(key);
  if (existing) {
    if (existing.external?.skipExistenceCheck && !usage.skipExistenceCheck) {
      existing.external = { ...existing.external, skipExistenceCheck: false };
    }
    if (!existing.sourceMap.mappings.some(mapping =>
      mapping.sourceFile === usage.sourceFile
      && mapping.sourceRange.start === usage.range.start
      && mapping.sourceRange.end === usage.range.end
    )) {
      existing.sourceMap.mappings.push({
        generatedPath: "",
        sourceFile: usage.sourceFile,
        sourceRange: usage.range,
        reason: "direct",
        expansionStack: []
      });
    }
    return;
  }

  const unit = createExternalResource(
    usage.resourceKind,
    usage.id,
    usage.source,
    usage.skipExistenceCheck,
    usage.sourceFile,
    usage.range
  );
  if (unit) {
    units.set(key, unit);
  }
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

interface CollectedExternDeclarations {
  declarations: RsglExternDeclaration[];
  diagnostics: RsglCompileDiagnostic[];
}

function collectExternDeclarations(
  files: readonly RsglSourceFile[],
  globalEntries: readonly RsglGlobalExternConfigEntry[] | undefined,
  suppliedDeclarations: readonly RsglExternDeclaration[] | undefined
): CollectedExternDeclarations {
  const declarations: RsglExternDeclaration[] = [...(suppliedDeclarations ?? [])];
  const diagnostics: RsglCompileDiagnostic[] = [];

  for (const file of files) {
    for (const statement of externDeclarationsInStatements(file.module.statements)) {
      if (!statement.source) {
        continue;
      }
      const resourceKind = getExternResourceKind(statement.resourceKind?.text);
      if (!resourceKind) {
        continue;
      }
      for (const patternNode of statement.patterns) {
        const parsed = parseExternResourcePattern(patternNode.text);
        if (parsed.pattern) {
          declarations.push({
            source: statement.source,
            resourceKind,
            pattern: parsed.pattern,
            skipExistenceCheck: statement.skipExistenceCheck,
            fileName: file.fileName,
            range: patternNode.range
          });
        }
      }
    }
  }

  for (const [entryIndex, entry] of (globalEntries ?? []).entries()) {
    const resourceKind = getExternResourceKind(entry.kind);
    if (!resourceKind || (entry.source !== "custom" && entry.source !== "vanilla") || !Array.isArray(entry.patterns)) {
      diagnostics.push(configurationExternDiagnostic(
        `Invalid global extern entry at extern[${entryIndex}].`
      ));
      continue;
    }
    for (const [patternIndex, patternText] of entry.patterns.entries()) {
      const parsed = typeof patternText === "string" ? parseExternResourcePattern(patternText) : {};
      if (!parsed.pattern) {
        diagnostics.push(configurationExternDiagnostic(
          `Invalid global extern pattern at extern[${entryIndex}].patterns[${patternIndex}]: ${parsed.error ?? "expected a string pattern."}`
        ));
        continue;
      }
      declarations.push({
        source: entry.source,
        resourceKind,
        pattern: parsed.pattern,
        skipExistenceCheck: entry.checkExistence === false,
        checkExistence: entry.checkExistence
      });
    }
  }

  return { declarations, diagnostics };
}

function* externDeclarationsInStatements(
  statements: readonly TopLevelStatementNode[]
): Generator<ExternDeclNode> {
  for (const statement of statements) {
    if (statement.kind === "ExternDecl") {
      yield statement;
    }
    if (statement.kind === "TemplateDecl" && statement.body.kind === "Block") {
      yield* externDeclarationsInStatements(statement.body.statements);
    } else if (statement.kind === "ForStmt" && statement.body.kind === "Block") {
      yield* externDeclarationsInStatements(statement.body.statements);
    } else if (statement.kind === "IfStmt") {
      if (statement.thenBody.kind === "Block") {
        yield* externDeclarationsInStatements(statement.thenBody.statements);
      }
      if (statement.elseBody?.kind === "Block") {
        yield* externDeclarationsInStatements(statement.elseBody.statements);
      }
    } else if (statement.kind === "OverlayDecl") {
      yield* externDeclarationsInStatements(statement.body.statements);
    }
  }
}

function configurationExternDiagnostic(message: string): RsglCompileDiagnostic {
  return {
    code: "rsgl.invalidExternConfiguration",
    message,
    severity: "error",
    range: { start: 0, end: 1 },
    fileName: "rsgl.config.json"
  };
}
