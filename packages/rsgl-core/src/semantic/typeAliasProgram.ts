import type {
  ExportDeclNode,
  ImportDeclNode,
  RsglDiagnostic,
  RsglModule
} from "../parser";
import {
  normalizeRsglPath,
  RsglPathKeyMap,
  rsglPathKey
} from "../pathIdentity";
import { createScope } from "./scopes";
import { predeclareTypeAliases } from "./typeAliases";
import {
  resolveTypeAliasSymbol,
  type RsglFileDiagnostic,
  type RsglImportGraph,
  type RsglScope,
  type RsglSourceFile,
  type RsglTypeAliasSymbol
} from "./types";

export interface RsglProgramTypeAliasEnvironment {
  exportMaps: Map<string, Map<string, RsglTypeAliasSymbol>>;
  importsByFile: Map<string, Map<string, RsglTypeAliasSymbol>>;
  fileDiagnostics: RsglFileDiagnostic[];
}

interface TypeAliasModuleIndex {
  fileName: string;
  key: string;
  module: RsglModule;
  scope: RsglScope;
  localNames: Set<string>;
  imports: ImportDeclNode[];
  exports: ExportDeclNode[];
  importedAliases: Map<string, RsglTypeAliasSymbol>;
}

/**
 * Builds the type namespace before ordinary binding. This lets imported aliases
 * participate in the very first contextual annotation check instead of being
 * patched from Any/Unknown after expressions have already been checked.
 */
export function createRsglProgramTypeAliasEnvironment(
  files: readonly RsglSourceFile[],
  importGraph: RsglImportGraph
): RsglProgramTypeAliasEnvironment {
  const fileDiagnostics: RsglFileDiagnostic[] = [];
  const modules = files.map(indexModule);
  const byFile = new RsglPathKeyMap(modules.map(module => [module.fileName, module] as const));
  let exportMaps: Map<string, Map<string, RsglTypeAliasSymbol>> = new RsglPathKeyMap(
    modules.map(module => [module.fileName, new Map<string, RsglTypeAliasSymbol>()] as const)
  );
  const maximumPasses = Math.max(4, modules.length * 4 + importGraph.edges.length * 2);

  for (let pass = 0; pass < maximumPasses; pass++) {
    const nextMaps = computeExportMaps(modules, byFile, importGraph, exportMaps);
    const importsChanged = linkImports(modules, byFile, importGraph, nextMaps, fileDiagnostics);
    const exportsChanged = !sameExportMaps(exportMaps, nextMaps);
    exportMaps = nextMaps;
    if (!importsChanged && !exportsChanged) {
      break;
    }
  }

  resolveIndexedAliases(modules, fileDiagnostics);
  fileDiagnostics.push(...reExportCycleDiagnostics(modules, importGraph, exportMaps));
  return {
    exportMaps,
    importsByFile: new RsglPathKeyMap(
      modules.map(module => [module.fileName, module.importedAliases] as const)
    ),
    fileDiagnostics
  };
}

function indexModule(file: RsglSourceFile): TypeAliasModuleIndex {
  const fileName = normalizeRsglPath(file.fileName);
  const scope = createScope("global");
  const diagnostics: RsglDiagnostic[] = [];
  predeclareTypeAliases(file.module.statements, scope, diagnostics);
  // Ordinary binding owns local parser/duplicate diagnostics. This declaration
  // index is run before binding only to resolve cross-module dependencies.
  return {
    fileName,
    key: rsglPathKey(fileName),
    module: file.module,
    scope,
    localNames: new Set(scope.typeAliases.keys()),
    imports: file.module.statements.filter(
      (statement): statement is ImportDeclNode => statement.kind === "ImportDecl"
    ),
    exports: file.module.statements.filter(
      (statement): statement is ExportDeclNode => statement.kind === "ExportDecl"
    ),
    importedAliases: new Map()
  };
}

function computeExportMaps(
  modules: readonly TypeAliasModuleIndex[],
  byFile: ReadonlyMap<string, TypeAliasModuleIndex>,
  importGraph: RsglImportGraph,
  previous: ReadonlyMap<string, Map<string, RsglTypeAliasSymbol>>
): Map<string, Map<string, RsglTypeAliasSymbol>> {
  const result = new RsglPathKeyMap<Map<string, RsglTypeAliasSymbol>>();
  for (const module of modules) {
    const exported = new Map<string, RsglTypeAliasSymbol>();
    for (const declaration of module.exports) {
      if (!declaration.source) {
        for (const specifier of declaration.specifiers) {
          const alias = module.scope.typeAliases.get(specifier.local.text);
          if (alias && !exported.has(specifier.exported.text)) {
            exported.set(specifier.exported.text, alias);
          }
        }
        continue;
      }
      const target = exportTarget(module, declaration.source.value, importGraph, byFile);
      const targetExports = target ? previous.get(target.key) : undefined;
      if (!targetExports) {
        continue;
      }
      if (declaration.exportAll) {
        for (const [name, alias] of targetExports) {
          if (!exported.has(name)) {
            exported.set(name, alias);
          }
        }
      }
      for (const specifier of declaration.specifiers) {
        const alias = targetExports.get(specifier.local.text);
        if (alias && !exported.has(specifier.exported.text)) {
          exported.set(specifier.exported.text, alias);
        }
      }
    }
    result.set(module.key, exported);
  }
  return result;
}

function linkImports(
  modules: readonly TypeAliasModuleIndex[],
  byFile: ReadonlyMap<string, TypeAliasModuleIndex>,
  importGraph: RsglImportGraph,
  exportMaps: ReadonlyMap<string, Map<string, RsglTypeAliasSymbol>>,
  diagnostics: RsglFileDiagnostic[]
): boolean {
  let changed = false;
  for (const module of modules) {
    for (const declaration of module.imports) {
      if (!declaration.source) {
        continue;
      }
      const target = importTarget(module, declaration.source.value, importGraph, byFile);
      const targetExports = target ? exportMaps.get(target.key) : undefined;
      if (!targetExports) {
        continue;
      }
      if (
        !declaration.defaultName
        && !declaration.namespaceName
        && declaration.namedImports.length === 0
      ) {
        for (const [name, alias] of targetExports) {
          changed = installImportedAlias(module, name, alias, declaration.range, diagnostics) || changed;
        }
      }
      for (const specifier of declaration.namedImports) {
        const alias = targetExports.get(specifier.imported.text);
        if (alias) {
          changed = installImportedAlias(module, specifier.local.text, alias, specifier.range, diagnostics) || changed;
        }
      }
    }
  }
  return changed;
}

function installImportedAlias(
  module: TypeAliasModuleIndex,
  localName: string,
  alias: RsglTypeAliasSymbol,
  range: { start: number; end: number },
  diagnostics: RsglFileDiagnostic[]
): boolean {
  const existing = module.scope.typeAliases.get(localName);
  if (existing) {
    if (existing !== alias && !module.importedAliases.has(localName)) {
      pushUniqueDiagnostic(diagnostics, {
        fileName: module.fileName,
        code: "rsgl.duplicateTypeAlias",
        message: `Duplicate type binding '${localName}' in the type namespace.`,
        severity: "error",
        range
      });
    }
    return false;
  }
  module.scope.typeAliases.set(localName, alias);
  module.importedAliases.set(localName, alias);
  return true;
}

function resolveIndexedAliases(
  modules: readonly TypeAliasModuleIndex[],
  diagnostics: RsglFileDiagnostic[]
): void {
  for (const module of modules) {
    for (const name of module.localNames) {
      const alias = module.scope.typeAliases.get(name);
      if (alias) {
        resolveTypeAliasSymbol(alias, undefined, []);
      }
    }
  }
  for (const module of modules) {
    for (const name of module.localNames) {
      const alias = module.scope.typeAliases.get(name);
      if (alias?.invalid && alias.circularAcrossScopes) {
        pushUniqueDiagnostic(diagnostics, {
          fileName: module.fileName,
          code: "rsgl.circularTypeAlias",
          message: `Circular type alias '${alias.name}' crosses a module boundary.`,
          severity: "error",
          range: alias.node.name?.range ?? alias.node.range
        });
      }
    }
  }
}

function reExportCycleDiagnostics(
  modules: readonly TypeAliasModuleIndex[],
  importGraph: RsglImportGraph,
  exportMaps: ReadonlyMap<string, ReadonlyMap<string, RsglTypeAliasSymbol>>
): RsglFileDiagnostic[] {
  const reExportEdges = modules.flatMap(module => module.exports
    .filter(declaration => declaration.source)
    .flatMap(declaration => {
      const edge = importGraph.edges.find(candidate =>
        rsglPathKey(candidate.from) === module.key && candidate.source === declaration.source?.value
      );
      if (!edge) {
        return [];
      }
      const targetKey = rsglPathKey(edge.to);
      const targetAliases = exportMaps.get(targetKey);
      const carriesTypeAlias = declaration.exportAll
        ? Boolean(targetAliases?.size)
        : declaration.specifiers.some(specifier => targetAliases?.has(specifier.local.text));
      return carriesTypeAlias ? [{ module, declaration, to: targetKey }] : [];
    }));
  const adjacency = new Map<string, string[]>();
  for (const module of modules) {
    adjacency.set(module.key, []);
  }
  for (const edge of reExportEdges) {
    adjacency.get(edge.module.key)?.push(edge.to);
  }
  const cyclicFiles = cyclicGraphNodes(adjacency);
  return reExportEdges
    .filter(edge => cyclicFiles.has(edge.module.key) && cyclicFiles.has(edge.to))
    .map(edge => ({
      fileName: edge.module.fileName,
      code: "rsgl.circularTypeAliasReExport",
      message: "Circular type-alias re-export chain; break the re-export cycle.",
      severity: "error" as const,
      range: edge.declaration.source?.range ?? edge.declaration.range
    }));
}

function cyclicGraphNodes(adjacency: ReadonlyMap<string, readonly string[]>): Set<string> {
  const cyclic = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (fileName: string): void => {
    if (visiting.has(fileName)) {
      const start = stack.lastIndexOf(fileName);
      stack.slice(Math.max(0, start)).forEach(item => cyclic.add(item));
      return;
    }
    if (visited.has(fileName)) {
      return;
    }
    visiting.add(fileName);
    stack.push(fileName);
    for (const target of adjacency.get(fileName) ?? []) {
      visit(target);
    }
    stack.pop();
    visiting.delete(fileName);
    visited.add(fileName);
  };
  adjacency.forEach((_targets, fileName) => visit(fileName));
  return cyclic;
}

function importTarget(
  module: TypeAliasModuleIndex,
  source: string,
  importGraph: RsglImportGraph,
  byFile: ReadonlyMap<string, TypeAliasModuleIndex>
): TypeAliasModuleIndex | undefined {
  const edge = importGraph.edges.find(candidate =>
    rsglPathKey(candidate.from) === module.key && candidate.source === source
  );
  return edge ? byFile.get(rsglPathKey(edge.to)) : undefined;
}

const exportTarget = importTarget;

function sameExportMaps(
  left: ReadonlyMap<string, Map<string, RsglTypeAliasSymbol>>,
  right: ReadonlyMap<string, Map<string, RsglTypeAliasSymbol>>
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [fileName, leftMap] of left) {
    const rightMap = right.get(fileName);
    if (!rightMap || leftMap.size !== rightMap.size) {
      return false;
    }
    for (const [name, alias] of leftMap) {
      if (rightMap.get(name) !== alias) {
        return false;
      }
    }
  }
  return true;
}

function pushUniqueDiagnostic(
  diagnostics: RsglFileDiagnostic[],
  diagnostic: RsglFileDiagnostic
): void {
  if (!diagnostics.some(existing =>
    existing.fileName === diagnostic.fileName
    && existing.code === diagnostic.code
    && existing.range.start === diagnostic.range.start
    && existing.range.end === diagnostic.range.end
  )) {
    diagnostics.push(diagnostic);
  }
}
