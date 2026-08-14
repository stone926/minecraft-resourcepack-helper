import * as path from "node:path";
import { normalizeRsglPath, rsglPathKey } from "../pathIdentity";
import {
  includeRsglStdlibSourceFiles,
  isRsglStdlibImportSource,
  rsglStdlibVirtualFileName
} from "../stdlib";
import { bindRsglModule } from "./binder";
import { fileDiagnostic, toDiagnostic, withFileName } from "./diagnostics";
import { createRsglExportMaps } from "./exportResolution";
import { validateResolvedImportCalls } from "./importValidation";
import { validateResolvedProgramTemplateUses } from "./templateUseValidation";
import { validateTemplateRecursion } from "./templateRecursion";
import { validateResolvedProgramBlockstateSemantics } from "./blockstateSemanticValidation";
import { exportedLambdaReexportAnnotationDiagnostics } from "./lambdaAnalysis";
import { createRsglProgramTypeAliasEnvironment } from "./typeAliasProgram";
import { createModuleNamespaceType } from "./moduleNamespace";
import { rsglTypeKey } from "./typeNormalization";
import { templateOutputMetadataFingerprint } from "../templateOutput";
import { originalRsglSymbolDefinition } from "./symbolDefinition";
import { RsglModuleNamespaceCycleStabilizer } from "./moduleNamespaceStabilization";
import { cyclicImportComponentByFile } from "./importCycleAnalysis";
import { RsglImportGraphIndex } from "./importGraphIndex";
import {
  createRsglValueImportEnvironment,
  valueImportBindingsEqual
} from "./valueImportStabilization";
import {
  RsglBindOptions,
  RsglFileDiagnostic,
  RsglImportGraph,
  RsglModuleResolver,
  RsglProgram,
  RsglSemanticModel,
  RsglSourceFile,
  RsglSymbol,
  RsglType
} from "./types";

export function bindRsglProgram(files: RsglSourceFile[], options: RsglBindOptions = {}): RsglProgram {
  const sourceFiles = includeRsglStdlibSourceFiles(files, { stdlibRoot: options.stdlibRoot });
  const resolver = options.resolver ?? createDefaultResolver(sourceFiles);
  let models = sourceFiles.map(file => bindRsglModule(file.module, { ...options, fileName: file.fileName, resolver }));
  const importGraph = buildImportGraph(sourceFiles, models, resolver);
  const importGraphIndex = new RsglImportGraphIndex(importGraph);
  const typeAliases = createRsglProgramTypeAliasEnvironment(sourceFiles, importGraph);
  let typeOnlyImports = typeOnlyImportNamesByFile(
    models,
    createRsglExportMaps(models, importGraph, importGraphIndex).maps,
    importGraphIndex,
    typeAliases.exportMaps
  );
  if (Array.from(typeAliases.importsByFile.values()).some(imports => imports.size > 0)) {
    const maximumPasses = Math.max(2, sourceFiles.length + 1);
    for (let pass = 0; pass < maximumPasses; pass++) {
      models = sourceFiles.map(file => bindRsglModule(file.module, {
        ...options,
        fileName: file.fileName,
        resolver,
        prelinkedTypeAliases: typeAliases.importsByFile.get(rsglPathKey(file.fileName)),
        typeOnlyImportNames: typeOnlyImports.get(rsglPathKey(file.fileName))
      }));
      const next = typeOnlyImportNamesByFile(
        models,
        createRsglExportMaps(models, importGraph, importGraphIndex).maps,
        importGraphIndex,
        typeAliases.exportMaps
      );
      if (sameNameSets(typeOnlyImports, next)) {
        break;
      }
      typeOnlyImports = next;
    }
  }

  let namespaceInferenceDiagnostics: readonly RsglFileDiagnostic[] = [];
  const hasNamespaceImports = models.some(model =>
    model.imports.some(record => Boolean(record.namespaceName))
  );
  const hasValueImports = models.some(model =>
    model.imports.some(record => Boolean(record.importAll || record.namedImports.length > 0))
  );
  if (hasNamespaceImports || hasValueImports) {
    // Imported values must be available before expression binding. A final
    // symbol-only link leaves loop variables, locals, and collection inference
    // frozen at their provisional Any types.
    linkProgramSymbols(models, importGraph, importGraphIndex, typeAliases.exportMaps);
    let namespaces = moduleNamespaceTypesByFile(models, importGraph, importGraphIndex);
    const cyclicValueComponents = cyclicImportComponentByFile(importGraph);
    let valueImports = createRsglValueImportEnvironment(models, cyclicValueComponents);
    const namespaceCycleStabilizer = hasNamespaceImports
      ? new RsglModuleNamespaceCycleStabilizer(models, importGraph)
      : undefined;
    const baseMaximumPasses = Math.max(
      4,
      sourceFiles.length * 4 + importGraph.edges.length * 2
    );
    const maximumPasses = baseMaximumPasses
      + (namespaceCycleStabilizer?.additionalPassBudget() ?? 0);
    let changedInputFiles = filesNeedingSemanticRebind(
      sourceFiles,
      valueImports,
      namespaces
    );
    let dirtyFiles = includeCyclicComponentFiles(
      changedInputFiles,
      cyclicValueComponents
    );
    for (let pass = 0; pass < maximumPasses; pass++) {
      models = sourceFiles.map((file, index) => {
        const fileKey = rsglPathKey(file.fileName);
        if (!dirtyFiles.has(fileKey)) {
          return models[index];
        }
        const prelinkedValueImports = valueImports.get(fileKey);
        const prelinkedModuleNamespaces = namespaces.get(fileKey);
        return bindRsglModule(file.module, {
          ...options,
          fileName: file.fileName,
          resolver,
          prelinkedTypeAliases: typeAliases.importsByFile.get(fileKey),
          typeOnlyImportNames: typeOnlyImports.get(fileKey),
          prelinkedValueImports,
          prelinkedModuleNamespaces
        });
      });
      linkProgramSymbols(models, importGraph, importGraphIndex, typeAliases.exportMaps);
      const nextNamespacesRaw = moduleNamespaceTypesByFile(
        models,
        importGraph,
        importGraphIndex
      );
      const nextNamespaces = namespaceCycleStabilizer
        ? namespaceCycleStabilizer.stabilize(
            namespaces,
            nextNamespacesRaw,
            changedInputFiles
          )
        : nextNamespacesRaw;
      const nextValueImports = createRsglValueImportEnvironment(models, cyclicValueComponents);
      const nextChangedInputFiles = filesWithChangedSemanticInputs(
        sourceFiles,
        valueImports,
        nextValueImports,
        namespaces,
        nextNamespaces
      );
      if (nextChangedInputFiles.size === 0) {
        break;
      }
      changedInputFiles = nextChangedInputFiles;
      dirtyFiles = includeCyclicComponentFiles(
        changedInputFiles,
        cyclicValueComponents
      );
      namespaces = nextNamespaces;
      valueImports = nextValueImports;
    }
    namespaceInferenceDiagnostics = namespaceCycleStabilizer?.diagnostics() ?? [];
  }
  const linkedSymbols = linkProgramSymbols(
    models,
    importGraph,
    importGraphIndex,
    typeAliases.exportMaps
  );
  for (const model of models) {
    model.diagnostics = model.diagnostics.filter(diagnostic => !templateOutputDiagnosticCodes.has(diagnostic.code));
  }
  const templateUseDiagnostics = validateResolvedProgramTemplateUses(models);
  const templateRecursionDiagnostics = validateTemplateRecursion(models);
  const blockstateDiagnostics = validateResolvedProgramBlockstateSemantics(models);
  const importedCallDiagnostics = models.flatMap(model => withFileName(model.fileName, validateResolvedImportCalls(model)));
  const valueExportDiagnostics = linkedSymbols.exportDiagnostics.filter(diagnostic =>
    !isValueExportDiagnosticSatisfiedByTypeAlias(diagnostic, models, typeAliases.exportMaps)
  );
  const fileDiagnostics: RsglFileDiagnostic[] = [
    ...models.flatMap(model => withFileName(model.fileName, model.diagnostics)),
    ...typeAliases.fileDiagnostics,
    ...valueExportDiagnostics,
    ...linkedSymbols.importDiagnostics,
    ...namespaceInferenceDiagnostics,
    ...exportedLambdaReexportAnnotationDiagnostics(models, linkedSymbols.exportMaps),
    ...templateUseDiagnostics,
    ...templateRecursionDiagnostics,
    ...blockstateDiagnostics,
    ...importedCallDiagnostics,
    ...importGraph.missing.map(missing => fileDiagnostic(
      missing.from,
      "rsgl.missingImport",
      `RSGL import not found: ${missing.source}`,
      missing.range
    )),
    ...importCycleDiagnostics(importGraph)
  ];
  const diagnostics = fileDiagnostics.map(toDiagnostic);

  return {
    files: sourceFiles,
    models,
    importGraph,
    diagnostics,
    fileDiagnostics,
    valueExportMaps: linkedSymbols.exportMaps,
    typeAliasExportMaps: typeAliases.exportMaps,
    semanticConfigurationFingerprint: options.semanticConfigurationFingerprint
  };
}

const templateOutputDiagnosticCodes = new Set([
  "rsgl.templateRecursion",
  "rsgl.templateOutputDialectMismatch"
]);

interface LinkedProgramSymbols {
  exportMaps: Map<string, Map<string, RsglSymbol>>;
  exportDiagnostics: RsglFileDiagnostic[];
  importDiagnostics: RsglFileDiagnostic[];
}

interface ImportAllBinding {
  symbol: RsglSymbol;
  ownerRank: number;
}

interface ImportLinkPassResult {
  diagnostics: RsglFileDiagnostic[];
  changed: boolean;
}

function linkProgramSymbols(
  models: RsglSemanticModel[],
  importGraph: RsglImportGraph,
  importGraphIndex: RsglImportGraphIndex,
  typeAliasExportMaps: ReadonlyMap<string, ReadonlyMap<string, unknown>>
): LinkedProgramSymbols {
  const importAllBindings = new Map<RsglSemanticModel, Map<string, ImportAllBinding>>();
  const maxPasses = Math.max(4, models.length * 4 + importGraph.edges.length * 2);

  for (let pass = 0; pass < maxPasses; pass++) {
    const exports = createRsglExportMaps(models, importGraph, importGraphIndex);
    const imports = resolveProgramImports(
      models,
      importGraphIndex,
      exports.maps,
      importAllBindings,
      typeAliasExportMaps
    );
    if (!imports.changed) {
      return {
        exportMaps: exports.maps,
        exportDiagnostics: exports.fileDiagnostics,
        importDiagnostics: imports.diagnostics
      };
    }
  }

  // Import cycles are diagnosed separately. Recompute once so the returned
  // diagnostics/maps describe the latest bounded link state.
  const exports = createRsglExportMaps(models, importGraph, importGraphIndex);
  const imports = resolveProgramImports(
    models,
    importGraphIndex,
    exports.maps,
    importAllBindings,
    typeAliasExportMaps
  );
  return {
    exportMaps: exports.maps,
    exportDiagnostics: exports.fileDiagnostics,
    importDiagnostics: imports.diagnostics
  };
}

function resolveProgramImports(
  models: RsglSemanticModel[],
  importGraphIndex: RsglImportGraphIndex,
  exportMaps: Map<string, Map<string, RsglSymbol>>,
  importAllBindings: Map<RsglSemanticModel, Map<string, ImportAllBinding>>,
  typeAliasExportMaps: ReadonlyMap<string, ReadonlyMap<string, unknown>>
): ImportLinkPassResult {
  const diagnostics: RsglFileDiagnostic[] = [];
  let changed = false;
  const modelsByFile = new Map(models.map(model => [rsglPathKey(model.fileName), model]));

  for (const sourceModel of models) {
    const trackedBindings = importAllBindings.get(sourceModel) ?? new Map<string, ImportAllBinding>();
    importAllBindings.set(sourceModel, trackedBindings);
    for (const [recordRank, record] of sourceModel.imports.entries()) {
      const edge = importGraphIndex.resolve(
        sourceModel.fileName,
        record.source,
        record.resolvedFileName
      );
      const targetModel = edge ? modelsByFile.get(rsglPathKey(edge.to)) : undefined;
      if (!targetModel) {
        continue;
      }

      if (record.namespaceName) {
        const localSymbol = sourceModel.scope.symbols.get(record.namespaceName);
        if (localSymbol?.kind === "namespace" && localSymbol.node === record.node) {
          const namespaceType = createModuleNamespaceType(
            targetModel.fileName,
            exportMaps.get(rsglPathKey(targetModel.fileName)) ?? new Map(),
            { sourceFileForSymbol: symbol => sourceFileForSymbol(models, symbol) }
          );
          if (!sameModuleNamespaceType(localSymbol.type, namespaceType)) {
            localSymbol.type = namespaceType;
            changed = true;
          }
        }
      }

      for (const item of record.namedImports) {
        const exported = exportMaps.get(rsglPathKey(targetModel.fileName))?.get(item.imported);
        const localSymbol = sourceModel.scope.symbols.get(item.local);
        if (!exported) {
          if (typeAliasExportMaps.get(rsglPathKey(targetModel.fileName))?.has(item.imported)) {
            continue;
          }
          diagnostics.push(fileDiagnostic(
            sourceModel.fileName,
            "rsgl.missingImportedSymbol",
            `RSGL module '${record.source}' does not export '${item.imported}'.`,
            item.range
          ));
          continue;
        }
        if (localSymbol) {
          if (localSymbol.kind === "import" && localSymbol.importBinding?.kind === "named") {
            localSymbol.importBinding = { kind: "named", sourceFile: targetModel.fileName };
          }
          changed = updateLinkedSymbol(localSymbol, exported) || changed;
        }
      }
      if (record.importAll) {
        const exportedSymbols = exportMaps.get(rsglPathKey(targetModel.fileName)) ?? new Map();
        const importedNames = new Set<string>();
        for (const [name, exported] of exportedSymbols) {
          const tracked = trackedBindings.get(name);
          if (tracked) {
            if (recordRank <= tracked.ownerRank) {
              changed = updateBareImportOwner(
                tracked.symbol,
                targetModel.fileName,
                record.node.source?.range
              ) || changed;
              if (recordRank < tracked.ownerRank) {
                tracked.ownerRank = recordRank;
                changed = true;
              }
              changed = updateLinkedSymbol(tracked.symbol, exported) || changed;
              importedNames.add(name);
            }
            continue;
          }
          const existing = sourceModel.scope.symbols.get(name);
          if (existing?.kind === "import" && existing.importBinding?.kind === "all") {
            changed = updateBareImportOwner(
              existing,
              targetModel.fileName,
              record.node.source?.range
            ) || changed;
            trackedBindings.set(name, { symbol: existing, ownerRank: recordRank });
            changed = updateLinkedSymbol(existing, exported) || changed;
            importedNames.add(name);
            continue;
          }
          if (existing) {
            continue;
          }
          const symbol: RsglSymbol = {
            name,
            kind: "import",
            importBinding: { kind: "all", sourceFile: targetModel.fileName },
            type: exported.type,
            node: exported.node,
            range: record.node.source?.range,
            signature: exported.signature,
            finiteDomain: exported.finiteDomain
          };
          sourceModel.scope.symbols.set(name, symbol);
          sourceModel.symbols.push(symbol);
          trackedBindings.set(name, { symbol, ownerRank: recordRank });
          importedNames.add(name);
          changed = true;
        }
        if (importedNames.size > 0) {
          for (const reference of sourceModel.references) {
            if (importedNames.has(reference.name)) {
              reference.symbol = sourceModel.scope.symbols.get(reference.name);
            }
          }
          sourceModel.diagnostics = sourceModel.diagnostics.filter(diagnostic =>
            diagnostic.code !== "rsgl.undefinedSymbol" ||
            !sourceModel.references.some(reference =>
              importedNames.has(reference.name) &&
              reference.range.start === diagnostic.range.start &&
              reference.range.end === diagnostic.range.end
            )
          );
        }
      }
    }
  }

  return { diagnostics, changed };
}

function updateLinkedSymbol(local: RsglSymbol, exported: RsglSymbol): boolean {
  const changed = local.type !== exported.type
    || local.signature !== exported.signature
    || local.node !== exported.node
    || local.finiteDomain !== exported.finiteDomain;
  local.type = exported.type;
  local.signature = exported.signature;
  local.node = exported.node;
  local.finiteDomain = exported.finiteDomain;
  return changed;
}

function updateBareImportOwner(
  symbol: RsglSymbol,
  sourceFile: string,
  range: RsglSymbol["range"]
): boolean {
  const previousRange = symbol.range;
  const changed = symbol.importBinding?.kind !== "all"
    || symbol.importBinding.sourceFile !== sourceFile
    || previousRange?.start !== range?.start
    || previousRange?.end !== range?.end;
  symbol.importBinding = { kind: "all", sourceFile };
  symbol.range = range;
  return changed;
}

function moduleNamespaceTypesByFile(
  models: readonly RsglSemanticModel[],
  importGraph: RsglImportGraph,
  importGraphIndex: RsglImportGraphIndex
): Map<string, Map<string, RsglType>> {
  const exports = createRsglExportMaps([...models], importGraph, importGraphIndex).maps;
  const result = new Map<string, Map<string, RsglType>>();
  for (const model of models) {
    const fileName = rsglPathKey(model.fileName);
    const namespaces = new Map<string, RsglType>();
    result.set(fileName, namespaces);
    for (const record of model.imports) {
      if (!record.namespaceName || namespaces.has(record.namespaceName)) {
        continue;
      }
      const localSymbol = model.scope.symbols.get(record.namespaceName);
      if (localSymbol?.kind !== "namespace" || localSymbol.node !== record.node) {
        continue;
      }
      const edge = importGraphIndex.resolve(
        model.fileName,
        record.source,
        record.resolvedFileName
      );
      if (!edge) {
        continue;
      }
      namespaces.set(record.namespaceName, createModuleNamespaceType(
        edge.to,
        exports.get(rsglPathKey(edge.to)) ?? new Map(),
        { sourceFileForSymbol: symbol => sourceFileForSymbol(models, symbol) }
      ));
    }
  }
  return result;
}

function moduleNamespaceBindingsEqual(
  left: ReadonlyMap<string, RsglType> | undefined,
  right: ReadonlyMap<string, RsglType> | undefined
): boolean {
  const leftSize = left?.size ?? 0;
  const rightSize = right?.size ?? 0;
  if (leftSize !== rightSize) {
    return false;
  }
  if (!leftSize) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  for (const [name, leftType] of left) {
    const rightType = right.get(name);
    if (!rightType || !sameModuleNamespaceType(leftType, rightType)) {
      return false;
    }
  }
  return true;
}

function filesNeedingSemanticRebind(
  files: readonly RsglSourceFile[],
  valueImports: ReadonlyMap<string, ReadonlyMap<string, RsglSymbol>>,
  namespaces: ReadonlyMap<string, ReadonlyMap<string, RsglType>>
): Set<string> {
  return new Set(files
    .map(file => rsglPathKey(file.fileName))
    .filter(fileName =>
      Boolean(valueImports.get(fileName)?.size)
      || Boolean(namespaces.get(fileName)?.size)
    ));
}

function filesWithChangedSemanticInputs(
  files: readonly RsglSourceFile[],
  previousValueImports: ReadonlyMap<string, ReadonlyMap<string, RsglSymbol>>,
  nextValueImports: ReadonlyMap<string, ReadonlyMap<string, RsglSymbol>>,
  previousNamespaces: ReadonlyMap<string, ReadonlyMap<string, RsglType>>,
  nextNamespaces: ReadonlyMap<string, ReadonlyMap<string, RsglType>>
): Set<string> {
  return new Set(files
    .map(file => rsglPathKey(file.fileName))
    .filter(fileName =>
      !valueImportBindingsEqual(
        previousValueImports.get(fileName),
        nextValueImports.get(fileName)
      )
      || !moduleNamespaceBindingsEqual(
        previousNamespaces.get(fileName),
        nextNamespaces.get(fileName)
      )
    ));
}

function includeCyclicComponentFiles(
  changedInputFiles: ReadonlySet<string>,
  cyclicComponentByFile: ReadonlyMap<string, string>
): Set<string> {
  return new Set([
    ...changedInputFiles,
    ...cyclicComponentByFile.keys()
  ]);
}

function sameModuleNamespaceType(left: RsglType, right: RsglType): boolean {
  return moduleNamespaceTypeFingerprint(left) === moduleNamespaceTypeFingerprint(right);
}

function moduleNamespaceTypeFingerprint(type: RsglType): string {
  if (type.kind !== "ModuleNamespace") {
    return rsglTypeKey(type);
  }
  const members = Array.from(type.moduleNamespaceMembers ?? [])
    .map(([name, member]) => {
      const signature = member.symbol.signature;
      const signatureKey = signature
        ? [
            signature.parameters.map(parameter => [
              parameter.name,
              parameter.optional ? "optional" : "required",
              parameter.rest ? "rest" : "single",
              rsglTypeKey(parameter.type)
            ].join(":")).join(","),
            rsglTypeKey(signature.returnType),
            signature.valueFunction ? "valueFunction" : "callable",
            signature.templateOutput
              ? templateOutputMetadataFingerprint(signature.templateOutput)
              : "value"
          ].join("->")
        : "";
      return [
        name,
        member.category,
        rsglTypeKey(member.symbol.type),
        signatureKey,
        member.symbol.finiteDomain?.join(",") ?? ""
      ].join("=");
    })
    .join("|");
  return `${type.moduleNamespaceId ?? "?"}{${members}}`;
}

function sourceFileForSymbol(
  models: readonly RsglSemanticModel[],
  symbol: RsglSymbol
): string | undefined {
  const definition = originalRsglSymbolDefinition(models, symbol);
  if (definition) {
    return definition.fileName;
  }
  const owner = models.find(model => model.symbols.includes(symbol));
  return owner?.fileName;
}

function typeOnlyImportNamesByFile(
  models: readonly RsglSemanticModel[],
  valueExportMaps: ReadonlyMap<string, ReadonlyMap<string, RsglSymbol>>,
  importGraphIndex: RsglImportGraphIndex,
  typeExportMaps: ReadonlyMap<string, ReadonlyMap<string, unknown>>
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const model of models) {
    const fileName = rsglPathKey(model.fileName);
    const names = new Set<string>();
    for (const record of model.imports) {
      const edge = importGraphIndex.resolve(
        model.fileName,
        record.source,
        record.resolvedFileName
      );
      if (!edge) {
        continue;
      }
      const targetKey = rsglPathKey(edge.to);
      const valueExports = valueExportMaps.get(targetKey);
      const typeExports = typeExportMaps.get(targetKey);
      for (const item of record.namedImports) {
        if (typeExports?.has(item.imported) && !valueExports?.has(item.imported)) {
          names.add(item.local);
        }
      }
    }
    result.set(fileName, names);
  }
  return result;
}

function isValueExportDiagnosticSatisfiedByTypeAlias(
  diagnostic: RsglFileDiagnostic,
  models: readonly RsglSemanticModel[],
  typeExportMaps: ReadonlyMap<string, ReadonlyMap<string, unknown>>
): boolean {
  if (
    diagnostic.code !== "rsgl.missingExportedSymbol"
    && diagnostic.code !== "rsgl.missingReExportedSymbol"
  ) {
    return false;
  }
  const model = models.find(candidate =>
    rsglPathKey(candidate.fileName) === rsglPathKey(diagnostic.fileName)
  );
  if (!model) {
    return false;
  }
  for (const record of model.exports) {
    for (const specifier of record.specifiers) {
      if (
        specifier.range.start === diagnostic.range.start
        && specifier.range.end === diagnostic.range.end
        && typeExportMaps.get(rsglPathKey(model.fileName))?.has(specifier.exported)
      ) {
        return true;
      }
    }
  }
  return false;
}

function sameNameSets(
  left: ReadonlyMap<string, ReadonlySet<string>>,
  right: ReadonlyMap<string, ReadonlySet<string>>
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [fileName, leftNames] of left) {
    const rightNames = right.get(fileName);
    if (
      !rightNames
      || leftNames.size !== rightNames.size
      || Array.from(leftNames).some(name => !rightNames.has(name))
    ) {
      return false;
    }
  }
  return true;
}

function importCycleDiagnostics(importGraph: RsglImportGraph): RsglFileDiagnostic[] {
  return importGraph.cycles.flatMap(cycle => cycle.map((fileName, index) => {
    const nextFileName = cycle[(index + 1) % cycle.length];
    const edge = importGraph.edges.find(item =>
      rsglPathKey(item.from) === rsglPathKey(fileName)
      && rsglPathKey(item.to) === rsglPathKey(nextFileName)
    );
    return fileDiagnostic(
      fileName,
      "rsgl.importCycle",
      `RSGL import cycle includes ${fileName}.`,
      edge?.range ?? { start: 0, end: 1 }
    );
  }));
}

function createDefaultResolver(files: RsglSourceFile[]): RsglModuleResolver {
  const fileNamesByKey = new Map(files.map(file => [
    rsglPathKey(file.fileName),
    normalizeRsglPath(file.fileName)
  ]));
  return {
    resolveImport(fromFileName: string, source: string): string | null {
      if (isRsglStdlibImportSource(source)) {
        const virtual = rsglStdlibVirtualFileName(source);
        return virtual ? fileNamesByKey.get(rsglPathKey(virtual)) ?? null : null;
      }
      if (!source.startsWith(".")) {
        return null;
      }
      const resolved = normalizeRsglPath(path.resolve(path.dirname(fromFileName), source));
      return fileNamesByKey.get(rsglPathKey(resolved)) ?? null;
    }
  };
}

function buildImportGraph(
  files: RsglSourceFile[],
  models: RsglSemanticModel[],
  resolver: RsglModuleResolver
): RsglImportGraph {
  const normalizedFiles = uniqueDisplayPaths(files.map(file => normalizeRsglPath(file.fileName)));
  const edges: RsglImportGraph["edges"] = [];
  const missing: RsglImportGraph["missing"] = [];

  for (const model of models) {
    for (const record of model.imports) {
      const resolved = record.resolvedFileName ?? resolver.resolveImport(model.fileName, record.source);
      if (resolved) {
        edges.push({
          from: normalizeRsglPath(model.fileName),
          to: canonicalDisplayPath(normalizedFiles, resolved),
          source: record.source,
          range: record.node.source?.range ?? record.node.range
        });
      } else {
        missing.push({
          from: normalizeRsglPath(model.fileName),
          source: record.source,
          range: record.node.source?.range ?? record.node.range
        });
      }
    }
    for (const record of model.exports) {
      if (!record.source) {
        continue;
      }
      const resolved = record.resolvedFileName ?? resolver.resolveImport(model.fileName, record.source);
      if (resolved) {
        edges.push({
          from: normalizeRsglPath(model.fileName),
          to: canonicalDisplayPath(normalizedFiles, resolved),
          source: record.source,
          range: record.node.source?.range ?? record.node.range
        });
      } else {
        missing.push({
          from: normalizeRsglPath(model.fileName),
          source: record.source,
          range: record.node.source?.range ?? record.node.range
        });
      }
    }
  }

  return {
    files: normalizedFiles,
    edges,
    cycles: findCycles(normalizedFiles, edges),
    missing
  };
}

function findCycles(files: string[], edges: RsglImportGraph["edges"]): string[][] {
  const displayByKey = new Map(files.map(fileName => [rsglPathKey(fileName), fileName]));
  const adjacency = new Map<string, string[]>();
  for (const file of files) {
    adjacency.set(rsglPathKey(file), []);
  }
  for (const edge of edges) {
    adjacency.get(rsglPathKey(edge.from))?.push(rsglPathKey(edge.to));
  }

  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (file: string) => {
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      if (start >= 0) {
        cycles.push(stack.slice(start).map(key => displayByKey.get(key) ?? key));
      }
      return;
    }
    if (visited.has(file)) {
      return;
    }
    visiting.add(file);
    stack.push(file);
    for (const next of adjacency.get(file) ?? []) {
      visit(next);
    }
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  };

  files.map(rsglPathKey).forEach(visit);
  return cycles;
}

function uniqueDisplayPaths(fileNames: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const fileName of fileNames) {
    const key = rsglPathKey(fileName);
    if (!byKey.has(key)) {
      byKey.set(key, fileName);
    }
  }
  return [...byKey.values()];
}

function canonicalDisplayPath(fileNames: readonly string[], fileName: string): string {
  const key = rsglPathKey(fileName);
  return fileNames.find(candidate => rsglPathKey(candidate) === key) ?? normalizeRsglPath(fileName);
}
