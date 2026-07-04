import * as path from "node:path";
import { RsglDiagnostic } from "../parser";
import {
  RsglImportGraph,
  RsglSemanticModel,
  RsglSymbol
} from "./types";

export interface RsglExportMapResult {
  maps: Map<string, Map<string, RsglSymbol>>;
  diagnostics: RsglDiagnostic[];
}

export function createRsglExportMaps(
  models: RsglSemanticModel[],
  importGraph: RsglImportGraph
): RsglExportMapResult {
  const modelsByFile = new Map(models.map(model => [normalizeFileName(model.fileName), model]));
  const maps = new Map<string, Map<string, RsglSymbol>>();
  const diagnostics: RsglDiagnostic[] = [];
  const resolving = new Set<string>();

  const resolveModel = (model: RsglSemanticModel): Map<string, RsglSymbol> => {
    const fileName = normalizeFileName(model.fileName);
    const cached = maps.get(fileName);
    if (cached) {
      return cached;
    }

    const exports = new Map<string, RsglSymbol>();
    maps.set(fileName, exports);
    if (resolving.has(fileName)) {
      return exports;
    }
    resolving.add(fileName);

    if (model.exports.length === 0) {
      for (const symbol of model.symbols) {
        exports.set(symbol.name, symbol);
      }
    } else {
      for (const record of model.exports) {
        if (record.source) {
          const targetModel = resolveExportTargetModel(model, record.source, importGraph, modelsByFile);
          if (!targetModel) {
            continue;
          }
          const targetExports = resolveModel(targetModel);
          if (record.exportAll) {
            for (const [name, symbol] of targetExports) {
              setExport(exports, name, symbol, record.node.range, diagnostics);
            }
          }
          for (const specifier of record.specifiers) {
            const symbol = targetExports.get(specifier.local);
            if (!symbol) {
              diagnostics.push(diagnostic(
                "rsgl.missingReExportedSymbol",
                `RSGL module '${record.source}' does not export '${specifier.local}'.`,
                specifier.range
              ));
            } else {
              setExport(exports, specifier.exported, symbol, specifier.range, diagnostics);
            }
          }
        } else {
          if (record.exportAll) {
            diagnostics.push(diagnostic("rsgl.exportAllRequiresSource", "export * requires a source module.", record.node.range));
          }
          for (const specifier of record.specifiers) {
            const symbol = model.scope.symbols.get(specifier.local);
            if (!symbol) {
              diagnostics.push(diagnostic(
                "rsgl.missingExportedSymbol",
                `RSGL module does not define '${specifier.local}'.`,
                specifier.range
              ));
            } else {
              setExport(exports, specifier.exported, symbol, specifier.range, diagnostics);
            }
          }
        }
      }
    }

    resolving.delete(fileName);
    return exports;
  };

  for (const model of models) {
    resolveModel(model);
  }

  return { maps, diagnostics };
}

function resolveExportTargetModel(
  model: RsglSemanticModel,
  source: string,
  importGraph: RsglImportGraph,
  modelsByFile: Map<string, RsglSemanticModel>
): RsglSemanticModel | undefined {
  const currentFile = normalizeFileName(model.fileName);
  const targetFile = importGraph.edges.find(edge => edge.from === currentFile && edge.source === source)?.to;
  return targetFile ? modelsByFile.get(normalizeFileName(targetFile)) : undefined;
}

function setExport(
  exports: Map<string, RsglSymbol>,
  name: string,
  symbol: RsglSymbol,
  range: { start: number; end: number },
  diagnostics: RsglDiagnostic[]
): void {
  if (exports.has(name)) {
    diagnostics.push(diagnostic("rsgl.duplicateExport", `Duplicate RSGL export '${name}'.`, range));
    return;
  }
  exports.set(name, symbol);
}

function diagnostic(
  code: string,
  message: string,
  range: { start: number; end: number },
  severity: RsglDiagnostic["severity"] = "error"
): RsglDiagnostic {
  return { code, message, range, severity };
}

function normalizeFileName(fileName: string): string {
  return path.normalize(fileName);
}
