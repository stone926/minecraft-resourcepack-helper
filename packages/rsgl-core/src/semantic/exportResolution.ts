import * as path from "node:path";
import { RsglDiagnostic } from "../parser";
import { moduleExportMemberCategory } from "./moduleNamespace";
import {
  RsglFileDiagnostic,
  RsglImportGraph,
  RsglSemanticModel,
  RsglSymbol
} from "./types";

export interface RsglExportMapResult {
  maps: Map<string, Map<string, RsglSymbol>>;
  fileDiagnostics: RsglFileDiagnostic[];
}

interface ExportOwner {
  range: { start: number; end: number };
}

interface ExportResolutionState {
  maps: Map<string, Map<string, RsglSymbol>>;
  /**
   * One retained propagation route per exported name. A route contains every
   * module that the first winning export traversed, from its declaration-side
   * module to the current module. It lets export-star linking recognize a true
   * cycle back-edge without confusing a diamond re-export with that cycle.
   */
  routes: Map<string, Map<string, readonly string[]>>;
}

/**
 * Resolves local exports and re-export cycles with a bounded fixed point. Each
 * pass reads the previous complete state, so result order is independent of
 * source-file ordering and a cycle never observes a half-built map.
 */
export function createRsglExportMaps(
  models: RsglSemanticModel[],
  importGraph: RsglImportGraph
): RsglExportMapResult {
  const modelsByFile = new Map(models.map(model => [normalizeFileName(model.fileName), model]));
  let state: ExportResolutionState = {
    maps: new Map(models.map(model => [
      normalizeFileName(model.fileName),
      new Map<string, RsglSymbol>()
    ])),
    routes: new Map(models.map(model => [
      normalizeFileName(model.fileName),
      new Map<string, readonly string[]>()
    ]))
  };
  const maximumPasses = Math.max(4, models.length * 4 + importGraph.edges.length * 2);

  for (let pass = 0; pass < maximumPasses; pass++) {
    const next = buildExportMaps(models, importGraph, modelsByFile, state, undefined);
    if (sameExportState(state, next)) {
      state = next;
      break;
    }
    state = next;
  }

  const fileDiagnostics: RsglFileDiagnostic[] = [];
  state = buildExportMaps(models, importGraph, modelsByFile, state, fileDiagnostics);
  return { maps: state.maps, fileDiagnostics };
}

function buildExportMaps(
  models: readonly RsglSemanticModel[],
  importGraph: RsglImportGraph,
  modelsByFile: ReadonlyMap<string, RsglSemanticModel>,
  previous: ExportResolutionState,
  diagnostics: RsglFileDiagnostic[] | undefined
): ExportResolutionState {
  const maps = new Map<string, Map<string, RsglSymbol>>();
  const routes = new Map<string, Map<string, readonly string[]>>();
  for (const model of models) {
    const fileName = normalizeFileName(model.fileName);
    const exports = new Map<string, RsglSymbol>();
    const exportRoutes = new Map<string, readonly string[]>();
    const owners = new Map<string, ExportOwner>();
    maps.set(fileName, exports);
    routes.set(fileName, exportRoutes);

    if (model.exports.length === 0) {
      for (const symbol of model.symbols) {
        if (moduleExportMemberCategory(symbol)) {
          exports.set(symbol.name, symbol);
          exportRoutes.set(symbol.name, [fileName]);
          owners.set(symbol.name, { range: symbol.range ?? symbol.node?.range ?? model.module.range });
        }
      }
      continue;
    }

    for (const record of model.exports) {
      if (!record.source) {
        if (record.exportAll) {
          diagnostics?.push(diagnostic(
            model.fileName,
            "rsgl.exportAllRequiresSource",
            "export * requires a source module.",
            record.node.range
          ));
        }
        for (const specifier of record.specifiers) {
          const symbol = model.scope.symbols.get(specifier.local);
          if (!symbol) {
            diagnostics?.push(diagnostic(
              model.fileName,
              "rsgl.missingExportedSymbol",
              `RSGL module does not define '${specifier.local}'.`,
              specifier.range
            ));
          } else if (!moduleExportMemberCategory(symbol)) {
            diagnostics?.push(diagnostic(
              model.fileName,
              "rsgl.invalidExportedSymbolKind",
              `RSGL symbol '${specifier.local}' is not an exportable value or template.`,
              specifier.range
            ));
          } else {
            setExport(
              model.fileName,
              exports,
              exportRoutes,
              owners,
              specifier.exported,
              symbol,
              [fileName],
              specifier.range,
              diagnostics
            );
          }
        }
        continue;
      }

      const targetModel = resolveExportTargetModel(model, record.source, importGraph, modelsByFile);
      if (!targetModel) {
        continue;
      }
      const targetFileName = normalizeFileName(targetModel.fileName);
      const targetExports = previous.maps.get(targetFileName) ?? new Map();
      const targetRoutes = previous.routes.get(targetFileName) ?? new Map();
      if (record.exportAll) {
        for (const [name, symbol] of targetExports) {
          const route = targetRoutes.get(name) ?? [targetFileName];
          // Only export-star propagation may silently discard a repeated
          // symbol, and only when that exact route has returned to a module it
          // already traversed. Two independent stars (a diamond) do not
          // contain the current module and therefore remain a real duplicate.
          if (route.includes(fileName)) {
            continue;
          }
          setExport(
            model.fileName,
            exports,
            exportRoutes,
            owners,
            name,
            symbol,
            extendExportRoute(route, fileName),
            record.node.range,
            diagnostics
          );
        }
      }
      for (const specifier of record.specifiers) {
        const symbol = targetExports.get(specifier.local);
        if (!symbol) {
          diagnostics?.push(diagnostic(
            model.fileName,
            "rsgl.missingReExportedSymbol",
            `RSGL module '${record.source}' does not export '${specifier.local}'.`,
            specifier.range
          ));
        } else {
          const route = targetRoutes.get(specifier.local) ?? [targetFileName];
          setExport(
            model.fileName,
            exports,
            exportRoutes,
            owners,
            specifier.exported,
            symbol,
            extendExportRoute(route, fileName),
            specifier.range,
            diagnostics
          );
        }
      }
    }
  }
  return { maps, routes };
}

function resolveExportTargetModel(
  model: RsglSemanticModel,
  source: string,
  importGraph: RsglImportGraph,
  modelsByFile: ReadonlyMap<string, RsglSemanticModel>
): RsglSemanticModel | undefined {
  const currentFile = normalizeFileName(model.fileName);
  const targetFile = importGraph.edges.find(edge => edge.from === currentFile && edge.source === source)?.to;
  return targetFile ? modelsByFile.get(normalizeFileName(targetFile)) : undefined;
}

function setExport(
  fileName: string,
  exports: Map<string, RsglSymbol>,
  routes: Map<string, readonly string[]>,
  owners: Map<string, ExportOwner>,
  name: string,
  symbol: RsglSymbol,
  route: readonly string[],
  range: { start: number; end: number },
  diagnostics: RsglFileDiagnostic[] | undefined
): void {
  const existing = exports.get(name);
  if (!existing) {
    exports.set(name, symbol);
    routes.set(name, route);
    owners.set(name, { range });
    return;
  }
  diagnostics?.push(diagnostic(
    fileName,
    "rsgl.duplicateExportName",
    `Duplicate RSGL export name '${name}'.`,
    range
  ));
  const first = owners.get(name)?.range;
  if (first) {
    diagnostics?.push(diagnostic(
      fileName,
      "rsgl.duplicateExportName",
      `RSGL export name '${name}' was first defined here.`,
      first
    ));
  }
}

function sameExportState(
  left: ExportResolutionState,
  right: ExportResolutionState
): boolean {
  if (left.maps.size !== right.maps.size || left.routes.size !== right.routes.size) {
    return false;
  }
  for (const [fileName, leftMap] of left.maps) {
    const rightMap = right.maps.get(fileName);
    const leftRoutes = left.routes.get(fileName);
    const rightRoutes = right.routes.get(fileName);
    if (!rightMap || leftMap.size !== rightMap.size) {
      return false;
    }
    for (const [name, symbol] of leftMap) {
      if (
        rightMap.get(name) !== symbol
        || !sameRoute(leftRoutes?.get(name), rightRoutes?.get(name))
      ) {
        return false;
      }
    }
  }
  return true;
}

function sameRoute(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return Boolean(
    left
    && right
    && left.length === right.length
    && left.every((fileName, index) => fileName === right[index])
  );
}

function extendExportRoute(route: readonly string[], fileName: string): readonly string[] {
  return route.includes(fileName) ? route : [...route, fileName];
}

function diagnostic(
  fileName: string,
  code: string,
  message: string,
  range: { start: number; end: number },
  severity: RsglDiagnostic["severity"] = "error"
): RsglFileDiagnostic {
  return { fileName, code, message, range, severity };
}

function normalizeFileName(fileName: string): string {
  return path.normalize(fileName);
}
