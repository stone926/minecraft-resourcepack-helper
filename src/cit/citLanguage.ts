import { citLocationToLineCharacterRange } from "../utils/astLocationRanges";
import { uniqueValues } from "../../packages/mc-assets/src";
import { isCitGlobalPropertiesFileName } from "./citDocumentPaths";
import { resolveCitKey, resolveCitType } from "./citKeyResolution";
import {
  findCitPropertyEntryAtPosition,
  findPropertySeparator,
  firstNonWhitespaceIndex,
  getCitPropertiesEntries,
  getCitPropertiesParseResult,
  isPositionInLocation,
  parseCitPropertyLine,
  trimEndIndex,
  type CitPropertiesDocument,
  type CitPropertiesPosition,
  type CitPropertyEntry
} from "./citPropertiesParser";
import { citSpecService } from "./citSpecService";
import type {
  CitResourceKind,
  CitRuntimeStatus,
  CitType,
  CitValueType,
  ResolvedCitSpec,
  ResolvedCitSpecKey
} from "./citSpecTypes";

export type CitLanguageDocument = CitPropertiesDocument;

export interface CitTextRange {
  start: CitPropertiesPosition;
  end: CitPropertiesPosition;
}

export type CitCompletionKind = "key" | "enum" | "boolean" | "resource";

export interface CitCompletionCandidate {
  label: string;
  insertText: string;
  kind: CitCompletionKind;
  detail?: string;
  documentation?: string;
  triggerSuggest?: boolean;
}

export interface CitCompletionResult {
  insertingRange: CitTextRange;
  replacingRange: CitTextRange;
  candidates: CitCompletionCandidate[];
}

export interface CitHoverInfo {
  range: CitTextRange;
  key: string;
  title: string;
  description: string;
  valueType: CitValueType;
  appliesTo: Array<CitType | "base">;
  defaultValue?: string;
  aliases: string[];
  citResewnOnly: boolean;
  runtimeStatus?: CitRuntimeStatus;
  runtimeNote?: string;
}

export interface CitResourceCompletionData {
  items?: string[];
  enchantments?: string[];
}

export function getCitCompletionResult(
  document: CitLanguageDocument,
  position: CitPropertiesPosition,
  locale?: string,
  resources: CitResourceCompletionData = {}
): CitCompletionResult | null {
  const parseResult = getCitPropertiesParseResult(document);
  const lineText = parseResult.physicalLines[position.line] ?? "";
  const lineContext = getLineCompletionContext(lineText, position);
  if (!lineContext) {
    return null;
  }

  const entries = parseResult.entries;
  const spec = getEffectiveSpec(document.fileName, entries, locale);
  if (lineContext.kind === "key") {
    return {
      insertingRange: lineContext.insertingRange,
      replacingRange: lineContext.replacingRange,
      candidates: getKeyCompletionCandidates(
        spec,
        entries,
        lineContext.prefix,
        lineContext.currentLine,
        !lineContext.hasSeparator
      )
    };
  }

  const entry = parseCitPropertyLine(lineText, position.line + 1);
  if (!entry) {
    return null;
  }

  const resolution = resolveCitKey(spec, entry.key);
  if (!resolution) {
    return null;
  }

  return {
    insertingRange: lineContext.insertingRange,
    replacingRange: lineContext.replacingRange,
    candidates: getValueCompletionCandidates(resolution.spec, lineContext.prefix, resources)
  };
}

export function getCitHoverInfo(
  document: CitLanguageDocument,
  position: CitPropertiesPosition,
  locale?: string
): CitHoverInfo | null {
  const entries = getCitPropertiesEntries(document);
  const entry = findCitPropertyEntryAtPosition(entries, position);
  if (!entry) {
    return null;
  }

  const spec = getEffectiveSpec(document.fileName, entries, locale);
  const resolution = resolveCitKey(spec, entry.key) ??
    resolveCitKey(citSpecService.getAllCitSpec(locale), entry.key) ??
    resolveCitKey(citSpecService.getGlobalSpec(locale), entry.key);
  if (!resolution) {
    return null;
  }

  const hoverRange = isPositionInLocation(position, entry.keyRange) ? entry.keyRange : entry.valueRange;
  return {
    range: toTextRange(hoverRange),
    key: entry.key,
    title: resolution.spec.title,
    description: resolution.spec.description,
    valueType: resolution.valueType,
    appliesTo: resolution.spec.appliesTo ?? [],
    defaultValue: resolution.spec.default,
    aliases: resolution.spec.aliases ?? [],
    citResewnOnly: resolution.spec.citResewnOnly ?? false,
    runtimeStatus: resolution.runtimeStatus,
    runtimeNote: resolution.runtimeNote
  };
}

export function getEffectiveSpec(fileName: string, entries: CitPropertyEntry[], locale?: string): ResolvedCitSpec {
  if (isCitGlobalPropertiesFileName(fileName)) {
    return citSpecService.getGlobalSpec(locale);
  }

  return citSpecService.getCitSpec(resolveCitType(entries), locale);
}

function getLineCompletionContext(
  lineText: string,
  position: CitPropertiesPosition
): (
  | {
      kind: "key";
      prefix: string;
      insertingRange: CitTextRange;
      replacingRange: CitTextRange;
      currentLine: number;
      hasSeparator: boolean;
    }
  | {
      kind: "value";
      prefix: string;
      insertingRange: CitTextRange;
      replacingRange: CitTextRange;
    }
) | null {
  const contentStart = firstNonWhitespaceIndex(lineText);
  if (contentStart === lineText.length) {
    return {
      kind: "key",
      prefix: "",
      insertingRange: {
        start: { line: position.line, character: contentStart },
        end: { line: position.line, character: position.character }
      },
      replacingRange: {
        start: { line: position.line, character: contentStart },
        end: { line: position.line, character: position.character }
      },
      currentLine: position.line + 1,
      hasSeparator: false
    };
  }

  if (lineText[contentStart] === "#" || lineText[contentStart] === "!") {
    return null;
  }

  const separator = findPropertySeparator(lineText, contentStart);
  if (separator < 0 || position.character <= separator) {
    const keyEnd = separator < 0
      ? trimEndIndex(lineText, lineText.length)
      : trimEndIndex(lineText, separator);
    const end = Math.max(contentStart, keyEnd, position.character);
    return {
      kind: "key",
      prefix: lineText.slice(contentStart, position.character),
      insertingRange: {
        start: { line: position.line, character: contentStart },
        end: { line: position.line, character: position.character }
      },
      replacingRange: {
        start: { line: position.line, character: contentStart },
        end: { line: position.line, character: end }
      },
      currentLine: position.line + 1,
      hasSeparator: separator >= 0
    };
  }

  const valueStart = firstNonWhitespaceIndex(lineText, separator + 1);
  const tokenStart = findValueTokenStart(lineText, valueStart, position.character);
  return {
    kind: "value",
    prefix: lineText.slice(tokenStart, position.character),
    insertingRange: {
      start: { line: position.line, character: tokenStart },
      end: { line: position.line, character: position.character }
    },
    replacingRange: {
      start: { line: position.line, character: tokenStart },
      end: {
        line: position.line,
        character: findValueTokenEnd(lineText, position.character)
      }
    }
  };
}

function getKeyCompletionCandidates(
  spec: ResolvedCitSpec,
  entries: CitPropertyEntry[],
  prefix: string,
  currentLine: number,
  appendSeparator: boolean
): CitCompletionCandidate[] {
  const usedSingletonKeys = new Set<string>();
  for (const entry of entries) {
    if (entry.line === currentLine) {
      continue;
    }
    const resolution = resolveCitKey(spec, entry.key);
    if (resolution?.spec.singleton) {
      usedSingletonKeys.add(resolution.canonicalKey);
    }
  }
  const normalizedPrefix = prefix.trimStart();

  return citSpecService.getKeyCompletions(spec)
    .filter(key => key.key.startsWith(normalizedPrefix))
    .filter(key => !usedSingletonKeys.has(key.canonicalKey ?? key.key))
    .map(key => {
      const patternKey = key.key.endsWith(".");
      return {
        label: key.key,
        insertText: patternKey || !appendSeparator ? key.key : `${key.key}=`,
        kind: "key",
        detail: key.title,
        documentation: key.description,
        triggerSuggest: patternKey || appendSeparator
      };
    });
}

function getValueCompletionCandidates(
  spec: ResolvedCitSpecKey,
  prefix: string,
  resources: CitResourceCompletionData
): CitCompletionCandidate[] {
  if (spec.valueType === "enum" || spec.valueType === "blendFunc") {
    return enumCandidates(spec.enum ?? [], prefix, spec.title, spec.description);
  }

  if (spec.valueType === "boolean") {
    return enumCandidates(["true", "false"], prefix, spec.title, spec.description, "boolean");
  }

  if (spec.valueType === "resourceList" && spec.resourceKind) {
    return resourceCandidates(getResourceIds(resources, spec.resourceKind), prefix, spec);
  }

  return [];
}

function enumCandidates(
  values: string[],
  prefix: string,
  detail?: string,
  documentation?: string,
  kind: CitCompletionKind = "enum"
): CitCompletionCandidate[] {
  return values
    .filter(value => value.startsWith(prefix))
    .map(value => ({
      label: value,
      insertText: value,
      kind,
      detail,
      documentation
    }));
}

function resourceCandidates(
  values: string[],
  prefix: string,
  spec: ResolvedCitSpecKey
): CitCompletionCandidate[] {
  return uniqueValues(values)
    .sort()
    .filter(value => value.startsWith(prefix))
    .map(value => ({
      label: value,
      insertText: value,
      kind: "resource",
      detail: spec.title,
      documentation: spec.description
    }));
}

function getResourceIds(resources: CitResourceCompletionData, kind: CitResourceKind): string[] {
  return kind === "item" ? resources.items ?? [] : resources.enchantments ?? [];
}

function findValueTokenStart(lineText: string, valueStart: number, cursor: number): number {
  for (let index = cursor - 1; index >= valueStart; index--) {
    const character = lineText[index];
    if (character === " " || character === "\t" || character === "\f") {
      return index + 1;
    }
  }
  return valueStart;
}

function findValueTokenEnd(lineText: string, cursor: number): number {
  for (let index = cursor; index < lineText.length; index++) {
    const character = lineText[index];
    if (character === " " || character === "\t" || character === "\f") {
      return index;
    }
  }
  return cursor <= lineText.length - 1 && hasContinuationMarker(lineText)
    ? lineText.length - 1
    : lineText.length;
}

function hasContinuationMarker(lineText: string): boolean {
  let backslashes = 0;
  for (let index = lineText.length - 1; index >= 0 && lineText[index] === "\\"; index--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function toTextRange(location: CitPropertyEntry["keyRange"]): CitTextRange {
  return citLocationToLineCharacterRange(location);
}
