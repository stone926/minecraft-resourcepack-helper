import * as path from "node:path";
import { isCitGlobalPropertiesFileName, isCitPropertiesFileName } from "../utils/citPaths";
import { parseCitProperties, type CitPropertyEntry } from "../utils/citPropertiesParser";
import { getCitType, getEffectiveSpec, type CitLanguageDocument } from "../utils/citLanguage";
import { citSpecService } from "../services/citSpecService";
import type { AstLocation } from "../utils/locationChecker";
import type { ResolvedCitSpecKey } from "../utils/citSpecTypes";

export type CitDiagnosticSeverity = "error" | "warning" | "information";

export interface CitDiagnostic {
  range: AstLocation;
  message: string;
  severity: CitDiagnosticSeverity;
}

export interface CitDiagnosticsOptions {
  locale?: string;
  fileExists?: (fileName: string) => boolean;
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

  const entries = parseCitProperties(document.getText());
  const spec = getEffectiveSpec(document.fileName, entries, options.locale);
  const allCitSpec = citSpecService.getAllCitSpec(options.locale);
  const globalSpec = citSpecService.getGlobalSpec(options.locale);
  const diagnostics: CitDiagnostic[] = [];
  const seenSingletonKeys = new Map<string, CitPropertyEntry>();
  const globalFile = isCitGlobalPropertiesFileName(document.fileName);
  const citType = getCitType(entries);

  for (const entry of entries) {
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
  }

  if (globalFile) {
    diagnostics.push(...getGlobalPriorityDiagnostics(document.fileName, spec.globalPriority, options.fileExists));
  }

  return diagnostics;
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
  if (!/^nbt\.[A-Za-z0-9_.*-]+(?:\.[A-Za-z0-9_.*-]+)*$/.test(entry.key)) {
    return [createDiagnostic(entry.keyRange, `NBT key must include a valid path after 'nbt.'.`, "warning")];
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

  if (/^nbt\.display\.(?:Name|Lore\.(?:\d+|\*))$/.test(entry.key)) {
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

  const normalized = path.normalize(fileName);
  const segments = normalized.split(path.sep).filter(Boolean);
  const assetsIndex = findLastIndex(segments, segment => segment.toLowerCase() === "assets");
  if (assetsIndex < 0) {
    return [];
  }

  const packRoot = path.join(path.parse(normalized).root, ...segments.slice(0, assetsIndex));
  const currentRelative = segments.slice(assetsIndex + 2).join("/").toLowerCase();
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

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index--) {
    if (predicate(values[index])) {
      return index;
    }
  }

  return -1;
}
