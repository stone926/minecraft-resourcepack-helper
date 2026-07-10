import { citSpecService } from "./citSpecService";
import type {
  CitAssetKind,
  CitRuntimeStatus,
  CitSpecLookupResult,
  CitType,
  CitValueType,
  ResolvedCitSpec,
  ResolvedCitSpecKey
} from "./citSpecTypes";

export type CitResourceType = "textures" | "models";

export interface CitKeyResolution {
  inputKey: string;
  normalizedKey: string;
  canonicalKey: string;
  matchedBy: CitSpecLookupResult["matchedBy"];
  valueType: CitValueType;
  assetKind?: CitAssetKind;
  runtimeStatus?: CitRuntimeStatus;
  runtimeNote?: string;
  spec: ResolvedCitSpecKey;
}

export interface CitTypeEntry {
  key: string;
  value: string;
}

const citTypes = new Set<CitType>(["item", "armor", "elytra", "enchantment"]);
const defaultCitNamespace = "citresewn:";

export function normalizeCitKey(key: string): string {
  const normalized = key.trim();
  if (normalized.startsWith(defaultCitNamespace)) {
    return normalized.slice(defaultCitNamespace.length);
  }
  if (normalized.startsWith(":")) {
    return normalized.slice(1);
  }
  return normalized;
}

export function resolveCitKey(spec: ResolvedCitSpec, key: string): CitKeyResolution | null {
  const normalizedKey = normalizeCitKey(key);
  const lookup = citSpecService.lookupNormalizedKey(spec, normalizedKey);
  if (!lookup) {
    return null;
  }

  return {
    inputKey: key,
    normalizedKey,
    canonicalKey: lookup.spec.key,
    matchedBy: lookup.matchedBy,
    valueType: lookup.spec.valueType,
    assetKind: lookup.spec.assetKind,
    runtimeStatus: lookup.spec.runtimeStatus,
    runtimeNote: lookup.spec.runtimeNote,
    spec: lookup.spec
  };
}

export function resolveCitKeyForType(
  key: string,
  citType: CitType = "item",
  locale?: string
): CitKeyResolution | null {
  return resolveCitKey(citSpecService.getCitSpec(citType, locale), key);
}

export function resolveCitResourceType(
  key: string,
  citType: CitType = "item",
  locale?: string
): CitResourceType | null {
  const assetKind = resolveCitKeyForType(key, citType, locale)?.assetKind;
  if (assetKind === "texture") {
    return "textures";
  }
  if (assetKind === "model") {
    return "models";
  }
  return null;
}

export function resolveCitType(entries: readonly CitTypeEntry[], locale?: string): CitType {
  const spec = citSpecService.getAllCitSpec(locale);
  const typeEntry = entries.find(entry => resolveCitKey(spec, entry.key)?.canonicalKey === "type");
  const value = typeEntry?.value.trim();
  return citTypes.has(value as CitType) ? value as CitType : "item";
}
