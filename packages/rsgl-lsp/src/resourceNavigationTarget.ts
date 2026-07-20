import {
  resolveRsglPath,
  rsglPathKey,
  type RsglResourceAnalysisResult,
  type RsglResourceNavigationOccurrence
} from "../../rsgl-core/src";
import type {
  RsglResourceNavigationDeclarationMode,
  RsglResourceNavigationLogicalTargetDto,
  RsglResourceNavigationScope
} from "../../rsgl-shared/src";

export interface RsglResourceNavigationTargetSelection {
  target: RsglResourceNavigationLogicalTargetDto;
  resolutionScope: RsglResourceNavigationScope;
  declarationMode: RsglResourceNavigationDeclarationMode;
}

/**
 * Finds the compiler-owned canonical resource occurrence under the cursor.
 * Scope comes from the exact extern occurrence rather than reparsing syntax in
 * the protocol layer. A generated declaration/reference falls back to the
 * effective scope so cross-language incoming References can still be merged.
 */
export function resourceNavigationTargetsAtOffset(
  analysis: RsglResourceAnalysisResult,
  fileName: string,
  offset: number
): RsglResourceNavigationTargetSelection[] {
  const fileKey = rsglPathKey(resolveRsglPath(fileName));
  const occurrences = analysis.index.occurrencesByFile.get(fileKey) ?? [];
  const touched = occurrences.filter(occurrence =>
    occurrence.range.start <= offset && offset <= occurrence.range.end
  );
  if (touched.length === 0) {
    return [];
  }
  const narrowest = Math.min(...touched.map(rangeLength));
  const selections = touched
    .filter(occurrence => rangeLength(occurrence) === narrowest)
    .map(occurrence => selectionForOccurrence(analysis, occurrence));
  return [...new Map(selections.map(selection => [selectionIdentity(selection), selection])).values()]
    .sort(compareSelections);
}

function selectionForOccurrence(
  analysis: RsglResourceAnalysisResult,
  occurrence: RsglResourceNavigationOccurrence
): RsglResourceNavigationTargetSelection {
  const external = occurrence.role === "reference"
    ? analysis.externalResources.find(usage => sameOccurrence(usage, occurrence))
    : undefined;
  return {
    target: { kind: occurrence.kind, id: occurrence.id },
    resolutionScope: external?.source ?? "effective",
    declarationMode: external
      ? external.skipExistenceCheck ? "unchecked" : "checked"
      : "undeclared"
  };
}

function sameOccurrence(
  usage: RsglResourceAnalysisResult["externalResources"][number],
  occurrence: RsglResourceNavigationOccurrence
): boolean {
  return usage.targetKind === occurrence.kind
    && usage.id === occurrence.id
    && rsglPathKey(resolveRsglPath(usage.sourceFile)) === rsglPathKey(occurrence.fileName)
    && usage.range.start === occurrence.range.start
    && usage.range.end === occurrence.range.end;
}

function rangeLength(occurrence: RsglResourceNavigationOccurrence): number {
  return Math.max(0, occurrence.range.end - occurrence.range.start);
}

function selectionIdentity(selection: RsglResourceNavigationTargetSelection): string {
  return [
    selection.target.kind,
    selection.target.id,
    selection.resolutionScope,
    selection.declarationMode
  ].join("\0");
}

function compareSelections(
  left: RsglResourceNavigationTargetSelection,
  right: RsglResourceNavigationTargetSelection
): number {
  return left.target.kind.localeCompare(right.target.kind, "en")
    || left.target.id.localeCompare(right.target.id, "en")
    || left.resolutionScope.localeCompare(right.resolutionScope, "en")
    || left.declarationMode.localeCompare(right.declarationMode, "en");
}
