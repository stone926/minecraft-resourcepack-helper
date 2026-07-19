import type { TextRange } from "./parser";
import { walkRsglModule } from "./parser/astTraversal";
import { resolveRsglPath, rsglPathKey } from "./pathIdentity";
import { createRsglExportMaps } from "./semantic/exportResolution";
import {
  canonicalRsglSymbol,
  createRsglSymbolDefinitionIndex,
  type RsglSymbolDefinitionIndex
} from "./semantic/symbolDefinition";
import type {
  RsglProgram,
  RsglSemanticModel,
  RsglSymbol,
  RsglTypeAliasSymbol
} from "./semantic/types";

export type RsglSemanticOccurrenceProgram = Pick<
  RsglProgram,
  "models" | "importGraph" | "valueExportMaps" | "typeAliasExportMaps"
>;

export interface RsglSemanticOccurrenceContext {
  canonicalSymbols: WeakMap<RsglSymbol, RsglSymbol>;
  occurrencesByModel: WeakMap<RsglSemanticModel, RsglSemanticOccurrence[]>;
  symbolDefinitions?: RsglSymbolDefinitionIndex;
  valueExportMaps?: ReadonlyMap<string, ReadonlyMap<string, RsglSymbol>>;
}

const occurrenceContextsByProgram = new WeakMap<object, RsglSemanticOccurrenceContext>();

interface RsglSemanticOccurrenceBase {
  name: string;
  range: TextRange;
  isDeclaration: boolean;
}

export interface RsglValueOccurrence extends RsglSemanticOccurrenceBase {
  kind: "value";
  /** Symbol as presented at this occurrence, preserving local alias names. */
  symbol: RsglSymbol;
  /** Declaration-owned identity shared by imports and re-exports. */
  canonicalSymbol: RsglSymbol;
}

export interface RsglTypeAliasOccurrence extends RsglSemanticOccurrenceBase {
  kind: "typeAlias";
  alias: RsglTypeAliasSymbol;
}

export type RsglSemanticOccurrence = RsglValueOccurrence | RsglTypeAliasOccurrence;

/** Resolves every named semantic site in one linked module. */
export function getRsglSemanticOccurrences(
  program: RsglSemanticOccurrenceProgram,
  model: RsglSemanticModel,
  context: RsglSemanticOccurrenceContext = createRsglSemanticOccurrenceContext(program)
): RsglSemanticOccurrence[] {
  const cached = context.occurrencesByModel.get(model);
  if (cached) {
    return cached;
  }
  const occurrences: RsglSemanticOccurrence[] = [];
  const occurrencesByRange = new Map<string, RsglSemanticOccurrence[]>();
  const addValue = (
    symbol: RsglSymbol | undefined,
    name: string,
    range: TextRange,
    isDeclaration: boolean
  ): void => {
    if (!symbol) {
      return;
    }
    addOccurrence(occurrences, occurrencesByRange, {
      kind: "value",
      symbol,
      get canonicalSymbol() {
        return canonicalSymbolForOccurrence(program, context, symbol);
      },
      name,
      range,
      isDeclaration
    });
  };
  const addTypeAlias = (
    alias: RsglTypeAliasSymbol | undefined,
    name: string,
    range: TextRange,
    isDeclaration: boolean
  ): void => {
    if (!alias) {
      return;
    }
    addOccurrence(occurrences, occurrencesByRange, {
      kind: "typeAlias",
      alias,
      name,
      range,
      isDeclaration
    });
  };

  walkRsglModule(model.module, {
    enterType(type) {
      if (type.kind !== "NamedType" && type.kind !== "GenericType") {
        return;
      }
      addTypeAlias(model.scope.typeAliases.get(type.name.text), type.name.text, type.name.range, false);
    }
  });

  for (const reference of model.references) {
    addValue(reference.symbol, reference.name, reference.range, false);
  }
  const implicitImportSourceRanges = model.imports
    .filter(record => record.importAll && record.node.source)
    .map(record => record.node.source!.range);
  for (const symbol of model.symbols) {
    if (!symbol.range) {
      continue;
    }
    if (
      symbol.kind === "import"
      && implicitImportSourceRanges.some(range => sameRange(range, symbol.range!))
    ) {
      continue;
    }
    addValue(symbol, symbol.name, symbol.range, symbol.kind !== "import");
  }

  for (const record of model.imports) {
    for (const specifier of record.node.namedImports) {
      const symbol = model.scope.symbols.get(specifier.local.text);
      addValue(symbol, specifier.imported.text, specifier.imported.range, false);
      addValue(symbol, specifier.local.text, specifier.local.range, false);

      const alias = model.scope.typeAliases.get(specifier.local.text);
      addTypeAlias(alias, specifier.imported.text, specifier.imported.range, false);
      addTypeAlias(alias, specifier.local.text, specifier.local.range, false);
    }
  }

  const modelKey = rsglPathKey(model.fileName);
  const valueExportMaps = model.exports.length > 0
    ? valueExportMapsForContext(program, context)
    : undefined;
  for (const record of model.exports) {
    for (const specifier of record.node.specifiers) {
      const symbol = record.source
        ? valueExportMaps?.get(modelKey)?.get(specifier.exported.text)
        : model.scope.symbols.get(specifier.local.text)
          ?? valueExportMaps?.get(modelKey)?.get(specifier.exported.text);
      addValue(symbol, specifier.local.text, specifier.local.range, false);
      addValue(symbol, specifier.exported.text, specifier.exported.range, false);

      const alias = record.source
        ? program.typeAliasExportMaps?.get(modelKey)?.get(specifier.exported.text)
        : model.scope.typeAliases.get(specifier.local.text)
          ?? program.typeAliasExportMaps?.get(modelKey)?.get(specifier.exported.text);
      addTypeAlias(alias, specifier.local.text, specifier.local.range, false);
      addTypeAlias(alias, specifier.exported.text, specifier.exported.range, false);
    }
  }

  for (const statement of model.module.statements) {
    if (statement.kind !== "TypeAliasDecl" || !statement.name) {
      continue;
    }
    addTypeAlias(
      model.scope.typeAliases.get(statement.name.text),
      statement.name.text,
      statement.name.range,
      true
    );
  }

  occurrences.sort(compareOccurrences);
  context.occurrencesByModel.set(model, occurrences);
  return occurrences;
}

/** Selects the narrowest named semantic occurrence touched by the cursor. */
export function getRsglSemanticOccurrenceAtOffset(
  program: RsglSemanticOccurrenceProgram,
  model: RsglSemanticModel,
  offset: number,
  context: RsglSemanticOccurrenceContext = createRsglSemanticOccurrenceContext(program)
): RsglSemanticOccurrence | undefined {
  return getRsglSemanticOccurrences(program, model, context)
    .filter(occurrence => touchesRange(occurrence.range, offset))
    .sort(compareOccurrences)[0];
}

export function createRsglSemanticOccurrenceContext(
  program: RsglSemanticOccurrenceProgram
): RsglSemanticOccurrenceContext {
  const cached = occurrenceContextsByProgram.get(program);
  if (cached) {
    return cached;
  }
  const context: RsglSemanticOccurrenceContext = {
    canonicalSymbols: new WeakMap(),
    occurrencesByModel: new WeakMap(),
    valueExportMaps: program.valueExportMaps
  };
  occurrenceContextsByProgram.set(program, context);
  return context;
}

export function sameRsglSemanticTarget(
  left: RsglSemanticOccurrence,
  right: RsglSemanticOccurrence
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  return left.kind === "value"
    ? left.canonicalSymbol === (right as RsglValueOccurrence).canonicalSymbol
    : left.alias.node === (right as RsglTypeAliasOccurrence).alias.node;
}

export function semanticModelForRsglLanguageFile(
  program: Pick<RsglProgram, "models">,
  fileName: string
): RsglSemanticModel | undefined {
  const key = rsglPathKey(resolveRsglPath(fileName));
  return program.models.find(model => rsglPathKey(resolveRsglPath(model.fileName)) === key);
}

function addOccurrence(
  occurrences: RsglSemanticOccurrence[],
  occurrencesByRange: Map<string, RsglSemanticOccurrence[]>,
  occurrence: RsglSemanticOccurrence
): void {
  const rangeKey = `${occurrence.range.start}\0${occurrence.range.end}`;
  const sameRangeOccurrences = occurrencesByRange.get(rangeKey) ?? [];
  const existing = sameRangeOccurrences.find(candidate =>
    sameUnlinkedOccurrenceTarget(candidate, occurrence)
  );
  if (existing) {
    existing.isDeclaration ||= occurrence.isDeclaration;
    return;
  }
  occurrences.push(occurrence);
  sameRangeOccurrences.push(occurrence);
  occurrencesByRange.set(rangeKey, sameRangeOccurrences);
}

function sameUnlinkedOccurrenceTarget(
  left: RsglSemanticOccurrence,
  right: RsglSemanticOccurrence
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  return left.kind === "value"
    ? left.symbol === (right as RsglValueOccurrence).symbol
    : left.alias.node === (right as RsglTypeAliasOccurrence).alias.node;
}

function canonicalSymbolForOccurrence(
  program: RsglSemanticOccurrenceProgram,
  context: RsglSemanticOccurrenceContext,
  symbol: RsglSymbol
): RsglSymbol {
  const cached = context.canonicalSymbols.get(symbol);
  if (cached) {
    return cached;
  }
  context.symbolDefinitions ??= createRsglSymbolDefinitionIndex(program.models);
  const canonical = canonicalRsglSymbol(program.models, symbol, context.symbolDefinitions);
  context.canonicalSymbols.set(symbol, canonical);
  return canonical;
}

function compareOccurrences(
  left: RsglSemanticOccurrence,
  right: RsglSemanticOccurrence
): number {
  return rangeLength(left.range) - rangeLength(right.range)
    || left.range.start - right.range.start
    || left.range.end - right.range.end
    || occurrenceSelectionPriority(left) - occurrenceSelectionPriority(right)
    || Number(right.kind === "value") - Number(left.kind === "value");
}

/** Resolved expression references win over a synthetic resource declaration on the same token. */
function occurrenceSelectionPriority(occurrence: RsglSemanticOccurrence): number {
  if (
    occurrence.kind === "value"
    && !occurrence.isDeclaration
    && occurrence.symbol.kind !== "resource"
  ) {
    return 0;
  }
  return occurrence.isDeclaration ? 1 : 2;
}

function valueExportMapsForContext(
  program: RsglSemanticOccurrenceProgram,
  context: RsglSemanticOccurrenceContext
): ReadonlyMap<string, ReadonlyMap<string, RsglSymbol>> {
  context.valueExportMaps ??= program.valueExportMaps
    ?? createRsglExportMaps(program.models, program.importGraph).maps;
  return context.valueExportMaps;
}

function touchesRange(range: TextRange, offset: number): boolean {
  return range.start <= offset && offset <= range.end;
}

function sameRange(left: TextRange, right: TextRange): boolean {
  return left.start === right.start && left.end === right.end;
}

function rangeLength(range: TextRange): number {
  return Math.max(0, range.end - range.start);
}
