import * as path from "node:path";
import {
  includeRsglStdlibSourceFiles,
  isRsglStdlibImportSource,
  rsglStdlibVirtualFileName
} from "../stdlib";
import { bindRsglModule } from "./binder";
import { fileDiagnostic, toDiagnostic, withFileName } from "./diagnostics";
import { createRsglExportMaps } from "./exportResolution";
import { validateResolvedImportCalls } from "./importValidation";
import { resolveProgramTemplateOutputMetadata } from "./templateOutputResolution";
import { validateResolvedProgramTemplateUses } from "./templateUseValidation";
import { validateTemplateRecursion } from "./templateRecursion";
import {
  RsglBindOptions,
  RsglFileDiagnostic,
  RsglImportGraph,
  RsglModuleResolver,
  RsglProgram,
  RsglSemanticModel,
  RsglSourceFile,
  RsglSymbol
} from "./types";

export function bindRsglProgram(files: RsglSourceFile[], options: RsglBindOptions = {}): RsglProgram {
  const sourceFiles = includeRsglStdlibSourceFiles(files, { stdlibRoot: options.stdlibRoot });
  const resolver = options.resolver ?? createDefaultResolver(sourceFiles);
  const models = sourceFiles.map(file => bindRsglModule(file.module, { ...options, fileName: file.fileName, resolver }));
  const importGraph = buildImportGraph(sourceFiles, models, resolver);
  const linkedSymbols = linkProgramSymbols(models, importGraph);
  resolveProgramTemplateOutputMetadata(models);
  for (const model of models) {
    model.diagnostics = model.diagnostics.filter(diagnostic => !templateOutputDiagnosticCodes.has(diagnostic.code));
  }
  const templateUseDiagnostics = validateResolvedProgramTemplateUses(models);
  const templateRecursionDiagnostics = validateTemplateRecursion(models);
  const importedCallDiagnostics = models.flatMap(model => withFileName(model.fileName, validateResolvedImportCalls(model)));
  const fileDiagnostics: RsglFileDiagnostic[] = [
    ...models.flatMap(model => withFileName(model.fileName, model.diagnostics)),
    ...linkedSymbols.exportDiagnostics,
    ...linkedSymbols.importDiagnostics,
    ...templateUseDiagnostics,
    ...templateRecursionDiagnostics,
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
    semanticConfigurationFingerprint: options.semanticConfigurationFingerprint
  };
}

const templateOutputDiagnosticCodes = new Set([
  "rsgl.conflictingResolvedTemplateOutputDialects",
  "rsgl.implicitTemplateOutputDialect",
  "rsgl.templateRecursion",
  "rsgl.templateOutputDialectMismatch",
  "rsgl.templateOutputDialectRequired"
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
  importGraph: RsglImportGraph
): LinkedProgramSymbols {
  const importAllBindings = new Map<RsglSemanticModel, Map<string, ImportAllBinding>>();
  const maxPasses = Math.max(4, models.length * 4 + importGraph.edges.length * 2);

  for (let pass = 0; pass < maxPasses; pass++) {
    const exports = createRsglExportMaps(models, importGraph);
    const imports = resolveProgramImports(models, importGraph, exports.maps, importAllBindings);
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
  const imports = resolveProgramImports(models, importGraph, exports.maps, importAllBindings);
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
  importAllBindings: Map<RsglSemanticModel, Map<string, ImportAllBinding>>
): ImportLinkPassResult {
  const diagnostics: RsglFileDiagnostic[] = [];
  let changed = false;
  const modelsByFile = new Map(models.map(model => [normalizeFileName(model.fileName), model]));

  for (const sourceModel of models) {
    const trackedBindings = importAllBindings.get(sourceModel) ?? new Map<string, ImportAllBinding>();
    importAllBindings.set(sourceModel, trackedBindings);
    for (const [recordRank, record] of sourceModel.imports.entries()) {
      const currentFile = normalizeFileName(sourceModel.fileName);
      const edge = importGraph.edges.find(item =>
        item.from === currentFile
        && item.source === record.source
        && normalizeFileName(record.resolvedFileName ?? item.to) === item.to
      );
      const targetModel = edge ? modelsByFile.get(edge.to) : undefined;
      if (!targetModel) {
        continue;
      }

      for (const item of record.namedImports) {
        const exported = exportMaps.get(normalizeFileName(targetModel.fileName))?.get(item.imported);
        const localSymbol = sourceModel.scope.symbols.get(item.local);
        if (!exported) {
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
        const exportedSymbols = exportMaps.get(normalizeFileName(targetModel.fileName)) ?? new Map();
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

function importCycleDiagnostics(importGraph: RsglImportGraph): RsglFileDiagnostic[] {
  return importGraph.cycles.flatMap(cycle => cycle.map((fileName, index) => {
    const nextFileName = cycle[(index + 1) % cycle.length];
    const edge = importGraph.edges.find(item => item.from === fileName && item.to === nextFileName);
    return fileDiagnostic(
      fileName,
      "rsgl.importCycle",
      `RSGL import cycle includes ${fileName}.`,
      edge?.range ?? { start: 0, end: 1 }
    );
  }));
}

function createDefaultResolver(files: RsglSourceFile[]): RsglModuleResolver {
  const fileNames = new Set(files.map(file => normalizeFileName(file.fileName)));
  return {
    resolveImport(fromFileName: string, source: string): string | null {
      if (isRsglStdlibImportSource(source)) {
        const virtual = rsglStdlibVirtualFileName(source);
        return virtual && fileNames.has(normalizeFileName(virtual)) ? normalizeFileName(virtual) : null;
      }
      if (!source.startsWith(".")) {
        return null;
      }
      const resolved = normalizeFileName(path.resolve(path.dirname(fromFileName), source));
      return fileNames.has(resolved) ? resolved : null;
    }
  };
}

function buildImportGraph(
  files: RsglSourceFile[],
  models: RsglSemanticModel[],
  resolver: RsglModuleResolver
): RsglImportGraph {
  const normalizedFiles = files.map(file => normalizeFileName(file.fileName));
  const edges: RsglImportGraph["edges"] = [];
  const missing: RsglImportGraph["missing"] = [];

  for (const model of models) {
    for (const record of model.imports) {
      const resolved = record.resolvedFileName ?? resolver.resolveImport(model.fileName, record.source);
      if (resolved) {
        edges.push({
          from: normalizeFileName(model.fileName),
          to: normalizeFileName(resolved),
          source: record.source,
          range: record.node.source?.range ?? record.node.range
        });
      } else {
        missing.push({
          from: normalizeFileName(model.fileName),
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
          from: normalizeFileName(model.fileName),
          to: normalizeFileName(resolved),
          source: record.source,
          range: record.node.source?.range ?? record.node.range
        });
      } else {
        missing.push({
          from: normalizeFileName(model.fileName),
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
  const adjacency = new Map<string, string[]>();
  for (const file of files) {
    adjacency.set(file, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }

  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (file: string) => {
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      if (start >= 0) {
        cycles.push(stack.slice(start));
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

  files.forEach(visit);
  return cycles;
}

function normalizeFileName(fileName: string): string {
  return path.normalize(fileName);
}
