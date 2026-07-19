import type { TextRange } from "./parser";
import { getRsglMemberReferenceLocations } from "./memberLanguageIntelligence";
import { resolveRsglPath, rsglPathKey } from "./pathIdentity";
import {
  createRsglSemanticOccurrenceContext,
  getRsglSemanticOccurrenceAtOffset,
  getRsglSemanticOccurrences,
  semanticModelForRsglLanguageFile,
  type RsglSemanticOccurrence,
  type RsglSemanticOccurrenceContext,
  type RsglSemanticOccurrenceProgram
} from "./semanticOccurrences";
import type { RsglSymbol } from "./semantic";

export interface RsglReferenceLocation {
  fileName: string;
  range: TextRange;
}

interface IndexedRsglSemanticOccurrence {
  fileName: string;
  occurrence: RsglSemanticOccurrence;
}

interface RsglSemanticReferenceIndex {
  context: RsglSemanticOccurrenceContext;
  byValueSymbol: WeakMap<RsglSymbol, IndexedRsglSemanticOccurrence[]>;
  byTypeDeclaration: WeakMap<object, IndexedRsglSemanticOccurrence[]>;
  locationsByValueSymbol: WeakMap<RsglSymbol, CachedRsglReferenceLocations>;
  locationsByTypeDeclaration: WeakMap<object, CachedRsglReferenceLocations>;
}

interface CachedRsglReferenceLocations {
  withDeclarations: readonly RsglReferenceLocation[];
  withoutDeclarations: readonly RsglReferenceLocation[];
}

const semanticReferenceIndexes = new WeakMap<object, RsglSemanticReferenceIndex>();

/** Finds declaration-linked value, type, and structural field occurrences. */
export function getRsglSemanticReferenceLocations(
  program: RsglSemanticOccurrenceProgram,
  fileName: string,
  offset: number,
  includeDeclaration: boolean
): RsglReferenceLocation[] | undefined {
  const model = semanticModelForRsglLanguageFile(program, fileName);
  if (!model) {
    return undefined;
  }
  const context = createRsglSemanticOccurrenceContext(program);
  const target = getRsglSemanticOccurrenceAtOffset(program, model, offset, context);
  if (target && (target.kind !== "value" || target.canonicalSymbol.node)) {
    const index = semanticReferenceIndex(program, context);
    return [...referenceLocationsForTarget(index, target, includeDeclaration)];
  }

  const memberLocations = getRsglMemberReferenceLocations(
    program,
    fileName,
    offset,
    includeDeclaration
  );
  return memberLocations
    ? normalizeRsglReferenceLocations(memberLocations)
    : undefined;
}

/** True only when the cursor resolves to a declaration-owned resource symbol. */
export function isRsglResourceSemanticTargetAtOffset(
  program: RsglSemanticOccurrenceProgram,
  fileName: string,
  offset: number
): boolean {
  const model = semanticModelForRsglLanguageFile(program, fileName);
  if (!model) {
    return false;
  }
  const context = createRsglSemanticOccurrenceContext(program);
  const target = getRsglSemanticOccurrenceAtOffset(program, model, offset, context);
  return target?.kind === "value" && target.canonicalSymbol.kind === "resource";
}

function semanticReferenceIndex(
  program: RsglSemanticOccurrenceProgram,
  context: RsglSemanticOccurrenceContext = createRsglSemanticOccurrenceContext(program)
): RsglSemanticReferenceIndex {
  const cached = semanticReferenceIndexes.get(program);
  if (cached) {
    return cached;
  }
  const index: RsglSemanticReferenceIndex = {
    context,
    byValueSymbol: new WeakMap(),
    byTypeDeclaration: new WeakMap(),
    locationsByValueSymbol: new WeakMap(),
    locationsByTypeDeclaration: new WeakMap()
  };
  for (const owner of program.models) {
    for (const occurrence of getRsglSemanticOccurrences(program, owner, context)) {
      const item = { fileName: owner.fileName, occurrence };
      if (occurrence.kind === "value") {
        appendWeakMap(index.byValueSymbol, occurrence.canonicalSymbol, item);
      } else {
        appendWeakMap(index.byTypeDeclaration, occurrence.alias.node, item);
      }
    }
  }
  semanticReferenceIndexes.set(program, index);
  return index;
}

function referenceLocationsForTarget(
  index: RsglSemanticReferenceIndex,
  target: RsglSemanticOccurrence,
  includeDeclaration: boolean
): readonly RsglReferenceLocation[] {
  const indexed = indexedOccurrencesForTarget(index, target);
  const locations = target.kind === "value"
    ? cachedReferenceLocations(index.locationsByValueSymbol, target.canonicalSymbol, indexed)
    : cachedReferenceLocations(index.locationsByTypeDeclaration, target.alias.node, indexed);
  return includeDeclaration ? locations.withDeclarations : locations.withoutDeclarations;
}

function cachedReferenceLocations<TKey extends object>(
  cache: WeakMap<TKey, CachedRsglReferenceLocations>,
  key: TKey,
  indexed: readonly IndexedRsglSemanticOccurrence[]
): CachedRsglReferenceLocations {
  let locations = cache.get(key);
  if (!locations) {
    const toLocation = (item: IndexedRsglSemanticOccurrence): RsglReferenceLocation => ({
      fileName: item.fileName,
      range: item.occurrence.range
    });
    locations = {
      withDeclarations: normalizeRsglReferenceLocations(indexed.map(toLocation)),
      withoutDeclarations: normalizeRsglReferenceLocations(
        indexed.filter(item => !item.occurrence.isDeclaration).map(toLocation)
      )
    };
    cache.set(key, locations);
  }
  return locations;
}

function indexedOccurrencesForTarget(
  index: RsglSemanticReferenceIndex,
  target: RsglSemanticOccurrence
): readonly IndexedRsglSemanticOccurrence[] {
  return target.kind === "value"
    ? index.byValueSymbol.get(target.canonicalSymbol) ?? []
    : index.byTypeDeclaration.get(target.alias.node) ?? [];
}

function appendWeakMap<TKey extends object, TValue>(
  map: WeakMap<TKey, TValue[]>,
  key: TKey,
  value: TValue
): void {
  const values = map.get(key);
  if (values) {
    values.push(value);
  } else {
    map.set(key, [value]);
  }
}

export function normalizeRsglReferenceLocations(
  locations: readonly RsglReferenceLocation[]
): RsglReferenceLocation[] {
  const unique = new Map<string, RsglReferenceLocation>();
  for (const location of locations) {
    const fileName = resolveRsglPath(location.fileName);
    unique.set(
      `${rsglPathKey(fileName)}\0${location.range.start}\0${location.range.end}`,
      { fileName, range: location.range }
    );
  }
  return [...unique.values()].sort((left, right) =>
    rsglPathKey(left.fileName).localeCompare(rsglPathKey(right.fileName), "en")
    || left.range.start - right.range.start
    || left.range.end - right.range.end
  );
}
