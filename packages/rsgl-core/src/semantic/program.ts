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
  let importGraph = buildImportGraph(sourceFiles, models, resolver);
  const typeAliases = createRsglProgramTypeAliasEnvironment(sourceFiles, importGraph);
  let typeOnlyImports = typeOnlyImportNamesByFile(
    models,
    importGraph,
    createRsglExportMaps(models, importGraph).maps,
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
      importGraph = buildImportGraph(sourceFiles, models, resolver);
      const next = typeOnlyImportNamesByFile(
        models,
        importGraph,
        createRsglExportMaps(models, importGraph).maps,
        typeAliases.exportMaps
      );
      if (sameNameSets(typeOnlyImports, next)) {
        break;
      }
      typeOnlyImports = next;
    }
  }

  let namespaceInferenceDiagnostics: readonly RsglFileDiagnostic[] = [];
  if (models.some(model => model.imports.some(record => Boolean(record.namespaceName)))) {
    // Seed from a complete named/bare-import link so re-exported templates are
    // categorized by final metadata rather than provisional Any.
    linkProgramSymbols(models, importGraph, typeAliases.exportMaps);
    let namespaces = moduleNamespaceTypesByFile(models, importGraph);
    const namespaceCycleStabilizer = new RsglModuleNamespaceCycleStabilizer(models, importGraph);
    const maximumPasses = Math.max(4, sourceFiles.length * 4 + importGraph.edges.length * 2);
    for (let pass = 0; pass < maximumPasses; pass++) {
      models = sourceFiles.map(file => bindRsglModule(file.module, {
        ...options,
        fileName: file.fileName,
        resolver,
        prelinkedTypeAliases: typeAliases.importsByFile.get(rsglPathKey(file.fileName)),
        typeOnlyImportNames: typeOnlyImports.get(rsglPathKey(file.fileName)),
        prelinkedModuleNamespaces: namespaces.get(rsglPathKey(file.fileName))
      }));
      importGraph = buildImportGraph(sourceFiles, models, resolver);
      linkProgramSymbols(models, importGraph, typeAliases.exportMaps);
      const next = namespaceCycleStabilizer.stabilize(
        pass + 1,
        namespaces,
        moduleNamespaceTypesByFile(models, importGraph)
      );
      if (moduleNamespaceEnvironmentsEqual(namespaces, next)) {
        break;
      }
      namespaces = next;
    }
    namespaceInferenceDiagnostics = namespaceCycleStabilizer.diagnostics();
  }
  const linkedSymbols = linkProgramSymbols(models, importGraph, typeAliases.exportMaps);
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
  typeAliasExportMaps: ReadonlyMap<string, ReadonlyMap<string, unknown>>
): LinkedProgramSymbols {
  const importAllBindings = new Map<RsglSemanticModel, Map<string, ImportAllBinding>>();
  const maxPasses = Math.max(4, models.length * 4 + importGraph.edges.length * 2);

  for (let pass = 0; pass < maxPasses; pass++) {
    const exports = createRsglExportMaps(models, importGraph);
    const imports = resolveProgramImports(
      models,
      importGraph,
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
  const exports = createRsglExportMaps(models, importGraph);
  const imports = resolveProgramImports(
    models,
    importGraph,
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
  importGraph: RsglImportGraph,
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
      const currentFile = rsglPathKey(sourceModel.fileName);
      const edge = importGraph.edges.find(item =>
        rsglPathKey(item.from) === currentFile
        && item.source === record.source
        && rsglPathKey(record.resolvedFileName ?? item.to) === rsglPathKey(item.to)
      );
      const targetModel = edge ? modelsByFile.get(rsglPathKey(edge.to)) : undefined;
      if (!targetModel) {
        continue;
      }

      if (record.namespaceName) {
        const localSymbol = sourceModel.scope.symbols.get(record.namespaceName);
        if (localSymbol?.kind === "namespace") {
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
              if (recordRank < tracked.ownerRank) {
                tracked.ownerRank = recordRank;
                changed = true;
              }
              changed = updateLinkedSymbol(tracked.symbol, exported) || changed;
              importedNames.add(name);
            }
            continue;
          }
          if (sourceModel.scope.symbols.has(name)) {
            continue;
          }
          const symbol: RsglSymbol = {
            name,
            kind: "import",
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

function moduleNamespaceTypesByFile(
  models: readonly RsglSemanticModel[],
  importGraph: RsglImportGraph
): Map<string, Map<string, RsglType>> {
  const exports = createRsglExportMaps([...models], importGraph).maps;
  const result = new Map<string, Map<string, RsglType>>();
  for (const model of models) {
    const fileName = rsglPathKey(model.fileName);
    const namespaces = new Map<string, RsglType>();
    result.set(fileName, namespaces);
    for (const record of model.imports) {
      if (!record.namespaceName || namespaces.has(record.namespaceName)) {
        continue;
      }
      const edge = importGraph.edges.find(candidate =>
        rsglPathKey(candidate.from) === fileName
        && candidate.source === record.source
        && rsglPathKey(record.resolvedFileName ?? candidate.to) === rsglPathKey(candidate.to)
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

function moduleNamespaceEnvironmentsEqual(
  left: ReadonlyMap<string, ReadonlyMap<string, RsglType>>,
  right: ReadonlyMap<string, ReadonlyMap<string, RsglType>>
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [fileName, leftNamespaces] of left) {
    const rightNamespaces = right.get(fileName);
    if (!rightNamespaces || leftNamespaces.size !== rightNamespaces.size) {
      return false;
    }
    for (const [name, leftType] of leftNamespaces) {
      const rightType = rightNamespaces.get(name);
      if (!rightType || !sameModuleNamespaceType(leftType, rightType)) {
        return false;
      }
    }
  }
  return true;
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
  importGraph: RsglImportGraph,
  valueExportMaps: ReadonlyMap<string, ReadonlyMap<string, RsglSymbol>>,
  typeExportMaps: ReadonlyMap<string, ReadonlyMap<string, unknown>>
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const model of models) {
    const fileName = rsglPathKey(model.fileName);
    const names = new Set<string>();
    for (const record of model.imports) {
      const edge = importGraph.edges.find(candidate =>
        rsglPathKey(candidate.from) === fileName && candidate.source === record.source
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
