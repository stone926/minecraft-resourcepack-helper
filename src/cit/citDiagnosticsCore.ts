import * as path from "node:path";
import { lm, type LocalizedMessage } from "../i18n/messages";
import { isCitGlobalPropertiesFileName } from "./citDocumentPaths";
import { isCitPropertiesFileName } from "./citPaths";
import { getCitPropertiesParseResult, type CitPropertyEntry } from "./citPropertiesParser";
import { getEffectiveSpec, type CitLanguageDocument } from "./citLanguage";
import { normalizeCitKey, resolveCitKey, resolveCitType } from "./citKeyResolution";
import { citSpecService } from "./citSpecService";
import { citResourceIdService, type CitResourceIds } from "./citResourceIdService";
import type { AstLocation } from "../utils/locationChecker";
import type { ResolvedCitSpecKey } from "./citSpecTypes";

export type CitDiagnosticSeverity = "error" | "warning" | "information";

export interface CitDiagnostic {
  range: AstLocation;
  message: LocalizedMessage;
  severity: CitDiagnosticSeverity;
}

export interface CitDiagnosticsOptions {
  locale?: string;
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

  const parseResult = getCitPropertiesParseResult(document);
  const entries = parseResult.entries;
  const spec = getEffectiveSpec(document.fileName, entries, options.locale);
  const allCitSpec = citSpecService.getAllCitSpec(options.locale);
  const globalSpec = citSpecService.getGlobalSpec(options.locale);
  const diagnostics: CitDiagnostic[] = parseResult.errors.map(error =>
    createDiagnostic(error.range, error.message, "warning")
  );
  const seenSingletonKeys = new Map<string, CitPropertyEntry>();
  const globalFile = isCitGlobalPropertiesFileName(document.fileName);
  const citType = resolveCitType(entries);

  for (const entry of entries) {
    if (entry.hasSyntaxError) {
      continue;
    }

    const lookup = resolveCitKey(spec, entry.key);
    if (!lookup) {
      const knownCit = resolveCitKey(allCitSpec, entry.key);
      const knownGlobal = resolveCitKey(globalSpec, entry.key);
      if (globalFile && knownCit) {
        diagnostics.push(createDiagnostic(
          entry.keyRange,
          lm("CIT key '{0}' is not valid in global cit.properties.", entry.key),
          "warning"
        ));
      } else if (!globalFile && knownGlobal) {
        diagnostics.push(createDiagnostic(
          entry.keyRange,
          lm("Global key '{0}' is only valid in cit.properties.", entry.key),
          "warning"
        ));
      } else if (knownCit) {
        diagnostics.push(createDiagnostic(
          entry.keyRange,
          lm("CIT key '{0}' is not valid for type '{1}'.", entry.key, citType),
          "warning"
        ));
      } else {
        diagnostics.push(createDiagnostic(entry.keyRange, lm("Unknown CIT key '{0}'.", entry.key), "warning"));
      }
      continue;
    }

    const canonicalKey = lookup.canonicalKey;
    if (lookup.spec.singleton) {
      const first = seenSingletonKeys.get(canonicalKey);
      if (first) {
        diagnostics.push(createDiagnostic(
          entry.keyRange,
          lm("Duplicate CIT key '{0}'.", entry.key),
          "warning"
        ));
      } else {
        seenSingletonKeys.set(canonicalKey, entry);
      }
    }

    if (entry.value.trim().length === 0 && requiresValue(lookup.spec)) {
      diagnostics.push(createDiagnostic(entry.valueRange, lm("CIT key '{0}' requires a value.", entry.key), "warning"));
      continue;
    }

    diagnostics.push(...validateValue(entry, lookup.spec));
    diagnostics.push(...validateResourceIds(entry, lookup.spec, options.resourceIds));
    diagnostics.push(...validateRuntimeStatus(entry, lookup.spec));
  }

  if (!globalFile) {
    diagnostics.push(...validateCitTypeRules(document.fileName, entries, citType, options.resourceIds));
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
      spec.resourceKind === "item"
        ? lm("Unknown item id '{0}'.", value)
        : lm("Unknown enchantment id '{0}'.", value),
      "warning"
    ));
}

function validateCitTypeRules(
  fileName: string,
  entries: CitPropertyEntry[],
  citType: string,
  resourceIds: CitResourceIds | undefined
): CitDiagnostic[] {
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
    lm("type=item requires items unless the file name is a valid item id."),
    "warning"
  )];
}

function validateElytraCitRules(entries: CitPropertyEntry[]): CitDiagnostic[] {
  const diagnostics: CitDiagnostic[] = [];
  const items = entries.find(entry => isItemsKey(entry.key));
  if (items) {
    diagnostics.push(createDiagnostic(items.keyRange, lm("items is ignored for type=elytra; the target is minecraft:elytra."), "information"));
  }
  if (!entries.some(entry => normalizeCitKey(entry.key) === "texture")) {
    diagnostics.push(createDiagnostic(
      entries[0]?.keyRange ?? { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      lm("type=elytra should declare texture."),
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
      lm("Item '{0}' is not an armor item.", citResourceIdService.normalizeItemId(value)),
      "warning"
    ));
}

function validateRuntimeStatus(entry: CitPropertyEntry, spec: ResolvedCitSpecKey): CitDiagnostic[] {
  if (spec.runtimeStatus !== "legacy") {
    return [];
  }

  return [createDiagnostic(
    entry.keyRange,
    spec.runtimeNote
      ? lm("CIT key '{0}' uses legacy runtime behavior. {1}", entry.key, spec.runtimeNote)
      : lm("CIT key '{0}' uses legacy runtime behavior.", entry.key),
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
        lm("Invalid value '{0}'. Expected one of: {1}.", value, (spec.enum ?? []).join(", ")),
        "warning"
      ));
    }
  } else if (spec.valueType === "boolean") {
    if (value !== "true" && value !== "false") {
      diagnostics.push(createDiagnostic(entry.valueRange, lm("Invalid boolean value '{0}'.", value), "warning"));
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
    return [createDiagnostic(entry.valueRange, lm("Invalid integer value '{0}'.", value), "warning")];
  }

  const numberValue = Number(value);
  if (spec.valueType === "positiveInteger" && numberValue <= 0) {
    return [createDiagnostic(entry.valueRange, lm("Value must be greater than 0."), "warning")];
  }
  if (spec.minimum !== undefined && numberValue < spec.minimum) {
    return [createDiagnostic(entry.valueRange, lm("Value must be at least {0}.", spec.minimum), "warning")];
  }
  if (spec.maximum !== undefined && numberValue > spec.maximum) {
    return [createDiagnostic(entry.valueRange, lm("Value must be at most {0}.", spec.maximum), "warning")];
  }
  return [];
}

function validateNumber(entry: CitPropertyEntry, spec: ResolvedCitSpecKey): CitDiagnostic[] {
  const value = entry.value.trim();
  if (!numberPattern.test(value)) {
    return [createDiagnostic(entry.valueRange, lm("Invalid number value '{0}'.", value), "warning")];
  }

  const numberValue = Number(value);
  if (spec.valueType === "positiveNumber" && numberValue <= 0) {
    return [createDiagnostic(entry.valueRange, lm("Value must be greater than 0."), "warning")];
  }
  if (spec.valueType === "nonNegativeNumber" && numberValue < 0) {
    return [createDiagnostic(entry.valueRange, lm("Value must be at least {0}.", 0), "warning")];
  }
  if (spec.minimum !== undefined && numberValue < spec.minimum) {
    return [createDiagnostic(entry.valueRange, lm("Value must be at least {0}.", spec.minimum), "warning")];
  }
  if (spec.maximum !== undefined && numberValue > spec.maximum) {
    return [createDiagnostic(entry.valueRange, lm("Value must be at most {0}.", spec.maximum), "warning")];
  }
  return [];
}

function validateRangeList(entry: CitPropertyEntry, spec: ResolvedCitSpecKey, allowList: boolean): CitDiagnostic[] {
  const tokens = entry.value.trim().split(/\s+/).filter(Boolean);
  if (!allowList && tokens.length > 1) {
    return [createDiagnostic(entry.valueRange, lm("Expected a single range value."), "warning")];
  }

  for (const token of tokens) {
    if (!isValidRangeToken(token, spec)) {
      return [createDiagnostic(entry.valueRange, lm("Invalid range value '{0}'.", token), "warning")];
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
    return [createDiagnostic(entry.valueRange, lm("Blend must be a named mode or 2/4 OpenGL parameters."), "warning")];
  }

  if (!parts.every(isBlendParameter)) {
    return [createDiagnostic(entry.valueRange, lm("Blend contains an invalid OpenGL parameter."), "warning")];
  }

  return [];
}

function validateNbtMatch(entry: CitPropertyEntry): CitDiagnostic[] {
  const normalizedKey = normalizeCitKey(entry.key);
  if (!/^(?:nbt|component|components)\.[A-Za-z0-9_.*:~-]+(?:\.[A-Za-z0-9_.*:~-]+)*$/.test(normalizedKey)) {
    return [createDiagnostic(entry.keyRange, lm("CIT component/NBT key must include a valid path after its prefix."), "warning")];
  }

  const regexPrefix = /^(?:regex|iregex):/.exec(entry.value);
  if (regexPrefix) {
    const pattern = entry.value.slice(regexPrefix[0].length);
    try {
      new RegExp(pattern);
    } catch {
      return [createDiagnostic(entry.valueRange, lm("Invalid regular expression."), "warning")];
    }
  }

  if (/^nbt\.display\.(?:Name|Lore\.(?:\d+|\*))$/.test(normalizedKey)) {
    const value = entry.value.replace(/^(?:regex|iregex|pattern|ipattern):/, "");
    if (value.trim().startsWith("{") || value.trim().startsWith("[")) {
      try {
        JSON.parse(value);
      } catch {
        return [createDiagnostic(entry.valueRange, lm("Invalid JSON text component."), "warning")];
      }
    }
  }

  return [];
}

function isItemsKey(key: string): boolean {
  const normalizedKey = normalizeCitKey(key);
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

function createDiagnostic(range: AstLocation, message: LocalizedMessage, severity: CitDiagnosticSeverity): CitDiagnostic {
  return { range, message, severity };
}
