import * as path from "node:path";
import { parseAssetsPath } from "../../packages/mc-assets/src";
import { isCitGlobalPropertiesFileName, isCitPropertiesFileName } from "./citPaths";
import { parseCitPropertiesDocument, type CitPropertyEntry } from "./citPropertiesParser";
import { getCitType, getEffectiveSpec, type CitLanguageDocument } from "./citLanguage";
import { stripDefaultCitNamespace } from "./citKeys";
import { citSpecService } from "./citSpecService";
import { citResourceIdService, type CitResourceIds } from "./citResourceIdService";
import type { AstLocation } from "../utils/locationChecker";
import type { ResolvedCitSpecKey } from "./citSpecTypes";

export type CitDiagnosticSeverity = "error" | "warning" | "information";

export interface CitDiagnostic {
  range: AstLocation;
  message: string;
  severity: CitDiagnosticSeverity;
}

export interface CitDiagnosticsOptions {
  locale?: string;
  fileExists?: (fileName: string) => boolean;
  resourceIds?: CitResourceIds;
}

const integerPattern = /^-?\d+$/;
const numberPattern = /^-?(?:\d+\.?\d*|\.\d+)$/;

export function getCitDiagnostics(
  document: CitLanguageDocument,
  options: CitDiagnosticsOptions = {}
): CitDiagnostic[] {
  if (!isCitPropertiesFileName(document.fileName)) {
    return [];
  }

  const parseResult = parseCitPropertiesDocument(document.getText());
  const entries = parseResult.entries;
  const spec = getEffectiveSpec(document.fileName, entries, options.locale);
  const allCitSpec = citSpecService.getAllCitSpec(options.locale);
  const globalSpec = citSpecService.getGlobalSpec(options.locale);
  const diagnostics: CitDiagnostic[] = parseResult.errors.map(error =>
    createDiagnostic(error.range, error.message, "warning")
  );
  const seenSingletonKeys = new Map<string, CitPropertyEntry>();
  const globalFile = isCitGlobalPropertiesFileName(document.fileName);
  const citType = getCitType(entries);

  for (const entry of entries) {
    if (entry.hasSyntaxError) {
      continue;
    }

    const lookup = citSpecService.lookupKey(spec, entry.key);
    if (!lookup) {
      const knownCit = citSpecService.lookupKey(allCitSpec, entry.key);
      const knownGlobal = citSpecService.lookupKey(globalSpec, entry.key);
      if (globalFile && knownCit) {
        diagnostics.push(createDiagnostic(
          entry.keyRange,
          `CIT key '${entry.key}' is not valid in global cit.properties.`,
          "warning"
        ));
      } else if (!globalFile && knownGlobal) {
        diagnostics.push(createDiagnostic(
          entry.keyRange,
          `Global key '${entry.key}' is only valid in cit.properties.`,
          "warning"
        ));
      } else if (knownCit) {
        diagnostics.push(createDiagnostic(
          entry.keyRange,
          `CIT key '${entry.key}' is not valid for type '${citType}'.`,
          "warning"
        ));
      } else {
        diagnostics.push(createDiagnostic(entry.keyRange, `Unknown CIT key '${entry.key}'.`, "warning"));
      }
      continue;
    }

    const canonicalKey = lookup.spec.key;
    if (lookup.spec.singleton) {
      const first = seenSingletonKeys.get(canonicalKey);
      if (first) {
        diagnostics.push(createDiagnostic(
          entry.keyRange,
          `Duplicate CIT key '${entry.key}'.`,
          "warning"
        ));
      } else {
        seenSingletonKeys.set(canonicalKey, entry);
      }
    }

    if (entry.value.trim().length === 0 && requiresValue(lookup.spec)) {
      diagnostics.push(createDiagnostic(entry.valueRange, `CIT key '${entry.key}' requires a value.`, "warning"));
      continue;
    }

    diagnostics.push(...validateValue(entry, lookup.spec));
    diagnostics.push(...validateResourceIds(entry, lookup.spec, options.resourceIds));
    diagnostics.push(...validateRuntimeStatus(entry, lookup.spec));
  }

  if (!globalFile) {
    diagnostics.push(...validateCitTypeRules(document.fileName, entries, citType, options.resourceIds));
  }

  if (globalFile) {
    diagnostics.push(...getGlobalPriorityDiagnostics(document.fileName, spec.globalPriority, options.fileExists));
  }

  return diagnostics;
}

function validateResourceIds(
  entry: CitPropertyEntry,
  spec: ResolvedCitSpecKey,
  resourceIds: CitResourceIds | undefined
): CitDiagnostic[] {
  if (spec.valueType !== "resourceList" || !spec.resourceKind || !resourceIds) {
    return [];
  }

  const known = new Set(spec.resourceKind === "item" ? resourceIds.items : resourceIds.enchantments);
  return entry.value.trim().split(/\s+/)
    .filter(Boolean)
    .map(value => spec.resourceKind === "item"
      ? citResourceIdService.normalizeItemId(value)
      : citResourceIdService.normalizeEnchantmentId(value))
    .filter(value => !known.has(value))
    .map(value => createDiagnostic(
      entry.valueRange,
      `Unknown ${spec.resourceKind} id '${value}'.`,
      "warning"
    ));
}

function validateCitTypeRules(
  fileName: string,
  entries: CitPropertyEntry[],
  citType: string,
  resourceIds: CitResourceIds | undefined
): CitDiagnostic[] {
  // assets/cit rules are merged into the spec for metadata and future use, but
  // diagnostics execute these type-specific rules explicitly today.
  if (citType === "item") {
    return validateItemCitRules(fileName, entries, resourceIds);
  }
  if (citType === "elytra") {
    return validateElytraCitRules(entries);
  }
  if (citType === "armor") {
    return validateArmorCitRules(entries);
  }
  return [];
}

function validateItemCitRules(
  fileName: string,
  entries: CitPropertyEntry[],
  resourceIds: CitResourceIds | undefined
): CitDiagnostic[] {
  if (entries.some(entry => isItemsKey(entry.key))) {
    return [];
  }

  const inferredItem = inferItemIdFromFileName(fileName);
  if (resourceIds && inferredItem && new Set(resourceIds.items).has(inferredItem)) {
    return [];
  }

  return [createDiagnostic(
    entries[0]?.keyRange ?? { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
    `type=item requires items unless the file name is a valid item id.`,
    "warning"
  )];
}

function validateElytraCitRules(entries: CitPropertyEntry[]): CitDiagnostic[] {
  const diagnostics: CitDiagnostic[] = [];
  const items = entries.find(entry => isItemsKey(entry.key));
  if (items) {
    diagnostics.push(createDiagnostic(items.keyRange, `items is ignored for type=elytra; the target is minecraft:elytra.`, "information"));
  }
  if (!entries.some(entry => stripDefaultCitNamespace(entry.key) === "texture")) {
    diagnostics.push(createDiagnostic(
      entries[0]?.keyRange ?? { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      `type=elytra should declare texture.`,
      "warning"
    ));
  }
  return diagnostics;
}

function validateArmorCitRules(entries: CitPropertyEntry[]): CitDiagnostic[] {
  const items = entries.find(entry => isItemsKey(entry.key));
  if (!items) {
    return [];
  }

  return items.value.trim().split(/\s+/)
    .filter(Boolean)
    .filter(value => !citResourceIdService.isArmorItem(value))
    .map(value => createDiagnostic(
      items.valueRange,
      `Item '${citResourceIdService.normalizeItemId(value)}' is not an armor item.`,
      "warning"
    ));
}

function validateRuntimeStatus(entry: CitPropertyEntry, spec: ResolvedCitSpecKey): CitDiagnostic[] {
  if (spec.runtimeStatus !== "legacy") {
    return [];
  }

  const note = spec.runtimeNote ? ` ${spec.runtimeNote}` : "";
  return [createDiagnostic(
    entry.keyRange,
    `CIT key '${entry.key}' has runtime status '${spec.runtimeStatus}'.${note}`,
    "warning"
  )];
}

function validateValue(entry: CitPropertyEntry, spec: ResolvedCitSpecKey): CitDiagnostic[] {
  const value = entry.value.trim();
  const diagnostics: CitDiagnostic[] = [];

  if (spec.valueType === "enum") {
    if (!(spec.enum ?? []).includes(value)) {
      diagnostics.push(createDiagnostic(
        entry.valueRange,
        `Invalid value '${value}'. Expected one of: ${(spec.enum ?? []).join(", ")}.`,
        "warning"
      ));
    }
  } else if (spec.valueType === "boolean") {
    if (value !== "true" && value !== "false") {
      diagnostics.push(createDiagnostic(entry.valueRange, `Invalid boolean value '${value}'.`, "warning"));
    }
  } else if (spec.valueType === "integer" || spec.valueType === "positiveInteger") {
    diagnostics.push(...validateInteger(entry, spec));
  } else if (
    spec.valueType === "number" ||
    spec.valueType === "positiveNumber" ||
    spec.valueType === "nonNegativeNumber"
  ) {
    diagnostics.push(...validateNumber(entry, spec));
  } else if (spec.valueType === "range") {
    diagnostics.push(...validateRangeList(entry, spec, false));
  } else if (spec.valueType === "rangeList") {
    diagnostics.push(...validateRangeList(entry, spec, true));
  } else if (spec.valueType === "blendFunc") {
    diagnostics.push(...validateBlendFunc(entry, spec));
  } else if (spec.valueType === "nbtMatch") {
    diagnostics.push(...validateNbtMatch(entry));
  }

  return diagnostics;
}

function validateInteger(entry: CitPropertyEntry, spec: ResolvedCitSpecKey): CitDiagnostic[] {
  const value = entry.value.trim();
  if (!integerPattern.test(value)) {
    return [createDiagnostic(entry.valueRange, `Invalid integer value '${value}'.`, "warning")];
  }

  const numberValue = Number(value);
  if (spec.valueType === "positiveInteger" && numberValue <= 0) {
    return [createDiagnostic(entry.valueRange, `Value must be greater than 0.`, "warning")];
  }
  if (spec.minimum !== undefined && numberValue < spec.minimum) {
    return [createDiagnostic(entry.valueRange, `Value must be at least ${spec.minimum}.`, "warning")];
  }
  if (spec.maximum !== undefined && numberValue > spec.maximum) {
    return [createDiagnostic(entry.valueRange, `Value must be at most ${spec.maximum}.`, "warning")];
  }
  return [];
}

function validateNumber(entry: CitPropertyEntry, spec: ResolvedCitSpecKey): CitDiagnostic[] {
  const value = entry.value.trim();
  if (!numberPattern.test(value)) {
    return [createDiagnostic(entry.valueRange, `Invalid number value '${value}'.`, "warning")];
  }

  const numberValue = Number(value);
  if (spec.valueType === "positiveNumber" && numberValue <= 0) {
    return [createDiagnostic(entry.valueRange, `Value must be greater than 0.`, "warning")];
  }
  if (spec.valueType === "nonNegativeNumber" && numberValue < 0) {
    return [createDiagnostic(entry.valueRange, `Value must be at least 0.`, "warning")];
  }
  if (spec.minimum !== undefined && numberValue < spec.minimum) {
    return [createDiagnostic(entry.valueRange, `Value must be at least ${spec.minimum}.`, "warning")];
  }
  if (spec.maximum !== undefined && numberValue > spec.maximum) {
    return [createDiagnostic(entry.valueRange, `Value must be at most ${spec.maximum}.`, "warning")];
  }
  return [];
}

function validateRangeList(entry: CitPropertyEntry, spec: ResolvedCitSpecKey, allowList: boolean): CitDiagnostic[] {
  const tokens = entry.value.trim().split(/\s+/).filter(Boolean);
  if (!allowList && tokens.length > 1) {
    return [createDiagnostic(entry.valueRange, `Expected a single range value.`, "warning")];
  }

  for (const token of tokens) {
    if (!isValidRangeToken(token, spec)) {
      return [createDiagnostic(entry.valueRange, `Invalid range value '${token}'.`, "warning")];
    }
  }

  return [];
}

function validateBlendFunc(entry: CitPropertyEntry, spec: ResolvedCitSpecKey): CitDiagnostic[] {
  const value = entry.value.trim();
  if ((spec.enum ?? []).includes(value)) {
    return [];
  }

  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length !== 2 && parts.length !== 4) {
    return [createDiagnostic(entry.valueRange, `Blend must be a named mode or 2/4 OpenGL parameters.`, "warning")];
  }

  if (!parts.every(isBlendParameter)) {
    return [createDiagnostic(entry.valueRange, `Blend contains an invalid OpenGL parameter.`, "warning")];
  }

  return [];
}

function validateNbtMatch(entry: CitPropertyEntry): CitDiagnostic[] {
  const normalizedKey = stripDefaultCitNamespace(entry.key);
  if (!/^(?:nbt|component|components)\.[A-Za-z0-9_.*:~-]+(?:\.[A-Za-z0-9_.*:~-]+)*$/.test(normalizedKey)) {
    return [createDiagnostic(entry.keyRange, `CIT component/NBT key must include a valid path after its prefix.`, "warning")];
  }

  const regexPrefix = /^(?:regex|iregex):/.exec(entry.value);
  if (regexPrefix) {
    const pattern = entry.value.slice(regexPrefix[0].length);
    try {
      new RegExp(pattern);
    } catch {
      return [createDiagnostic(entry.valueRange, `Invalid regular expression.`, "warning")];
    }
  }

  if (/^nbt\.display\.(?:Name|Lore\.(?:\d+|\*))$/.test(normalizedKey)) {
    const value = entry.value.replace(/^(?:regex|iregex|pattern|ipattern):/, "");
    if (value.trim().startsWith("{") || value.trim().startsWith("[")) {
      try {
        JSON.parse(value);
      } catch {
        return [createDiagnostic(entry.valueRange, `Invalid JSON text component.`, "warning")];
      }
    }
  }

  return [];
}

function isItemsKey(key: string): boolean {
  const normalizedKey = stripDefaultCitNamespace(key);
  return normalizedKey === "items" || normalizedKey === "matchItems";
}

function isValidRangeToken(token: string, spec: ResolvedCitSpecKey): boolean {
  const percent = token.endsWith("%");
  const raw = percent ? token.slice(0, -1) : token;
  if (percent && !spec.allowPercent) {
    return false;
  }

  const separator = raw.indexOf("-");
  if (separator > 0) {
    const left = raw.slice(0, separator);
    const right = raw.slice(separator + 1);
    return (left === "" || isRangeNumber(left, spec)) && (right === "" || isRangeNumber(right, spec));
  }

  return isRangeNumber(raw, spec);
}

function isRangeNumber(value: string, spec: ResolvedCitSpecKey): boolean {
  if (!integerPattern.test(value)) {
    return false;
  }

  const numberValue = Number(value);
  return spec.minimum === undefined || numberValue >= spec.minimum;
}

function isBlendParameter(value: string): boolean {
  return integerPattern.test(value) ||
    /^0x[0-9a-f]+$/i.test(value) ||
    /^GL_[A-Z0-9_]+$/.test(value);
}

function inferItemIdFromFileName(fileName: string): string | null {
  const basename = path.basename(fileName, path.extname(fileName));
  if (!/^[a-z0-9_.-]+$/.test(basename)) {
    return null;
  }
  return `minecraft:${basename}`;
}

function requiresValue(spec: ResolvedCitSpecKey): boolean {
  return spec.valueType !== "string";
}

function getGlobalPriorityDiagnostics(
  fileName: string,
  globalPriority: string[],
  fileExists: ((fileName: string) => boolean) | undefined
): CitDiagnostic[] {
  if (!fileExists) {
    return [];
  }

  const parsed = parseAssetsPath(fileName);
  if (!parsed) {
    return [];
  }

  const packRoot = path.dirname(parsed.assetsRoot);
  const currentRelative = parsed.relativeSegments.join("/").toLowerCase();
  const currentIndex = globalPriority.indexOf(currentRelative);
  if (currentIndex <= 0) {
    return [];
  }

  const higherPriority = globalPriority.slice(0, currentIndex)
    .map(relative => path.join(packRoot, "assets", "minecraft", ...relative.split("/")))
    .find(candidate => fileExists(candidate));
  if (!higherPriority) {
    return [];
  }

  return [createDiagnostic(
    { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
    `This global cit.properties is ignored because a higher-priority file exists: ${higherPriority}.`,
    "information"
  )];
}

function createDiagnostic(range: AstLocation, message: string, severity: CitDiagnosticSeverity): CitDiagnostic {
  return { range, message, severity };
}
