import type { TextRange } from "../parser";
import { logicalKeyIdentity } from "../../../mc-assets/src";
import { resolveRsglPath, rsglPathKey } from "../pathIdentity";
import type { RsglSourceFile } from "../semantic";
import { touchesRange } from "../textRangeQueries";
import {
  compileRsglProgram,
  type RsglProgramCompileOptions
} from "./compilePipeline";
import {
  generatedResourceKeysForUnit,
  type RsglGeneratedResourceKey
} from "./generatedResources";
import type { ResourceUnit, RsglCompileResult } from "./ir";
import type {
  RsglExternalResourceUsage,
  RsglResourceExistenceKind,
  RsglResourceReferenceUsage
} from "./validationTypes";

export interface RsglResourceNavigationLocation {
  fileName: string;
  range: TextRange;
}

export interface RsglResourceNavigationTarget {
  kind: RsglResourceExistenceKind;
  id: string;
}

export interface RsglResourceNavigationOccurrence
  extends RsglResourceNavigationLocation, RsglResourceNavigationTarget {
  role: "definition" | "reference";
}

/** Immutable, protocol-neutral lookup over one concrete compile result. */
export interface RsglResourceNavigationIndex {
  definitionsByTarget: ReadonlyMap<string, readonly RsglResourceNavigationLocation[]>;
  referencesByTarget: ReadonlyMap<string, readonly RsglResourceNavigationLocation[]>;
  occurrencesByFile: ReadonlyMap<string, readonly RsglResourceNavigationOccurrence[]>;
}

export interface RsglResourceNavigationBuildResult {
  index: RsglResourceNavigationIndex;
  compileResult: RsglCompileResult;
  /** Modules omitted so one incomplete editor buffer cannot invalidate its siblings. */
  skippedSourceFiles: readonly string[];
  /** Compiler-owned final-unit edge observations; no second compile is needed. */
  resourceReferences: readonly RsglResourceReferenceUsage[];
  externalResources: readonly RsglExternalResourceUsage[];
}

export type RsglResourceAnalysisResult = RsglResourceNavigationBuildResult;

/**
 * Compiles one source-root snapshot for navigation while isolating modules that
 * currently contain syntax errors. The regular compiler deliberately rejects
 * such a program atomically; navigation instead remains useful for independent
 * siblings and starts including a repaired module again on the next snapshot.
 */
export function compileRsglResourceNavigation(
  files: readonly RsglSourceFile[],
  options: RsglProgramCompileOptions = {}
): RsglResourceNavigationBuildResult {
  return compileRsglResourceAnalysis(files, {
    ...options,
    checkExternExistence: false
  });
}

/** Shared compiler analysis entry consumed by navigation, graph, and snapshots. */
export function compileRsglResourceAnalysis(
  files: readonly RsglSourceFile[],
  options: RsglProgramCompileOptions = {}
): RsglResourceAnalysisResult {
  const compilableFiles: RsglSourceFile[] = [];
  const skippedSourceFiles: string[] = [];
  for (const file of files) {
    if (file.module.diagnostics.some(diagnostic => diagnostic.severity === "error")) {
      skippedSourceFiles.push(resolveRsglPath(file.fileName));
    } else {
      compilableFiles.push(file);
    }
  }

  const references: RsglResourceReferenceUsage[] = [];
  const externalResources: RsglExternalResourceUsage[] = [];
  const observeReference = options.onResourceReferenceUsed;
  const observeExternal = options.onExternResourceUsed;
  const compileResult = compileRsglProgram(compilableFiles, {
    ...options,
    // A filtered file list no longer matches the caller's bound program. The
    // compiler will bind that smaller, internally consistent program once.
    ...(compilableFiles.length === files.length
      ? {}
      : { semanticProgram: undefined }),
    onResourceReferenceUsed: reference => {
      references.push(reference);
      observeReference?.(reference);
    },
    onExternResourceUsed: usage => {
      externalResources.push(usage);
      observeExternal?.(usage);
    }
  });
  return {
    index: createRsglResourceNavigationIndex(compileResult.units, references),
    compileResult,
    skippedSourceFiles,
    resourceReferences: references,
    externalResources
  };
}

/**
 * Builds navigation facts from compiler-owned canonical output identities and
 * reference observations. No resource existence or filesystem lookup occurs.
 */
export function createRsglResourceNavigationIndex(
  units: readonly ResourceUnit[],
  references: readonly RsglResourceReferenceUsage[]
): RsglResourceNavigationIndex {
  const occurrences: RsglResourceNavigationOccurrence[] = [];

  for (const unit of units) {
    const origins = unit.validation?.resourceDefinitionOrigins ?? [];
    if (origins.length === 0) {
      continue;
    }
    for (const target of generatedResourceKeysForUnit(unit)) {
      for (const origin of origins) {
        occurrences.push({
          kind: target.kind,
          id: target.id,
          role: "definition",
          fileName: origin.sourceFile,
          range: origin.sourceRange
        });
      }
    }
  }

  for (const reference of references) {
    occurrences.push({
      kind: reference.targetKind,
      id: reference.id,
      role: "reference",
      fileName: reference.sourceFile,
      range: reference.range
    });
  }

  const normalized = normalizeOccurrences(occurrences);
  const definitionsByTarget = new Map<string, RsglResourceNavigationLocation[]>();
  const referencesByTarget = new Map<string, RsglResourceNavigationLocation[]>();
  const occurrencesByFile = new Map<string, RsglResourceNavigationOccurrence[]>();

  for (const occurrence of normalized) {
    const targetMap = occurrence.role === "definition"
      ? definitionsByTarget
      : referencesByTarget;
    const target = targetKey(occurrence);
    appendToMap(targetMap, target, locationOf(occurrence));

    const fileKey = rsglPathKey(occurrence.fileName);
    appendToMap(occurrencesByFile, fileKey, occurrence);
  }

  return { definitionsByTarget, referencesByTarget, occurrencesByFile };
}

/** Resolves a touched definition or reference to every matching declaration. */
export function getRsglResourceDefinitionLocationsAtOffset(
  index: RsglResourceNavigationIndex,
  fileName: string,
  offset: number
): RsglResourceNavigationLocation[] {
  return locationsForTargets(
    touchedTargets(index, fileName, offset),
    index.definitionsByTarget
  );
}

/** Resolves all references to the touched concrete resource identity. */
export function getRsglResourceReferenceLocationsAtOffset(
  index: RsglResourceNavigationIndex,
  fileName: string,
  offset: number,
  includeDeclaration: boolean
): RsglResourceNavigationLocation[] {
  const targets = touchedTargets(index, fileName, offset);
  return normalizeLocations([
    ...locationsForTargets(targets, index.referencesByTarget),
    ...(includeDeclaration
      ? locationsForTargets(targets, index.definitionsByTarget)
      : [])
  ]);
}

function touchedTargets(
  index: RsglResourceNavigationIndex,
  fileName: string,
  offset: number
): RsglResourceNavigationTarget[] {
  const occurrences = index.occurrencesByFile.get(
    rsglPathKey(resolveRsglPath(fileName))
  ) ?? [];
  const touched = occurrences.filter(occurrence => touchesRange(occurrence.range, offset));
  if (touched.length === 0) {
    return [];
  }
  const narrowest = Math.min(...touched.map(occurrence => rangeLength(occurrence.range)));
  return [...new Map(touched
    .filter(occurrence => rangeLength(occurrence.range) === narrowest)
    .map(occurrence => [targetKey(occurrence), targetOf(occurrence)]))
    .values()];
}

function locationsForTargets(
  targets: readonly RsglResourceNavigationTarget[],
  locationsByTarget: ReadonlyMap<string, readonly RsglResourceNavigationLocation[]>
): RsglResourceNavigationLocation[] {
  return normalizeLocations(targets.flatMap(target =>
    locationsByTarget.get(targetKey(target)) ?? []
  ));
}

function normalizeOccurrences(
  occurrences: readonly RsglResourceNavigationOccurrence[]
): RsglResourceNavigationOccurrence[] {
  const unique = new Map<string, RsglResourceNavigationOccurrence>();
  for (const occurrence of occurrences) {
    const fileName = resolveRsglPath(occurrence.fileName);
    const normalized = { ...occurrence, fileName };
    unique.set([
      occurrence.role,
      targetKey(occurrence),
      rsglPathKey(fileName),
      occurrence.range.start,
      occurrence.range.end
    ].join("\0"), normalized);
  }
  return [...unique.values()].sort(compareOccurrences);
}

function normalizeLocations(
  locations: readonly RsglResourceNavigationLocation[]
): RsglResourceNavigationLocation[] {
  const unique = new Map<string, RsglResourceNavigationLocation>();
  for (const location of locations) {
    const fileName = resolveRsglPath(location.fileName);
    unique.set([
      rsglPathKey(fileName),
      location.range.start,
      location.range.end
    ].join("\0"), { fileName, range: location.range });
  }
  return [...unique.values()].sort(compareLocations);
}

function locationOf(
  occurrence: RsglResourceNavigationOccurrence
): RsglResourceNavigationLocation {
  return { fileName: occurrence.fileName, range: occurrence.range };
}

function targetOf(
  target: RsglResourceNavigationTarget
): RsglResourceNavigationTarget {
  return { kind: target.kind, id: target.id };
}

function targetKey(
  target: RsglResourceNavigationTarget | RsglGeneratedResourceKey
): string {
  return logicalKeyIdentity(target);
}

function compareOccurrences(
  left: RsglResourceNavigationOccurrence,
  right: RsglResourceNavigationOccurrence
): number {
  return compareLocations(left, right)
    || left.role.localeCompare(right.role, "en")
    || left.kind.localeCompare(right.kind, "en")
    || left.id.localeCompare(right.id, "en");
}

function compareLocations(
  left: RsglResourceNavigationLocation,
  right: RsglResourceNavigationLocation
): number {
  return rsglPathKey(left.fileName).localeCompare(rsglPathKey(right.fileName), "en")
    || left.range.start - right.range.start
    || left.range.end - right.range.end;
}

function rangeLength(range: TextRange): number {
  return Math.max(0, range.end - range.start);
}

function appendToMap<TKey, TValue>(
  map: Map<TKey, TValue[]>,
  key: TKey,
  value: TValue
): void {
  const values = map.get(key);
  if (values) {
    values.push(value);
    return;
  }
  map.set(key, [value]);
}
