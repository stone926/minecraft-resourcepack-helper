import * as fs from "node:fs";
import * as path from "node:path";
import { stripDefaultCitNamespace } from "./citKeys";
import { isCitGlobalPropertiesFileName } from "./citPaths";
import type {
  CitSpecFragment,
  CitSpecKey,
  CitSpecLookupResult,
  CitSpecScope,
  CitType,
  ResolvedCitSpec,
  ResolvedCitSpecKey
} from "./citSpecTypes";

const citTypes: CitType[] = ["item", "armor", "elytra", "enchantment"];
const requiredFragments = ["base", ...citTypes, "global-properties"];

interface LocaleFragments {
  fragments: Map<string, CitSpecFragment>;
}

export class CitSpecService {
  private readonly locales = new Map<string, LocaleFragments>();
  private readonly effectiveSpecs = new Map<string, ResolvedCitSpec>();

  constructor(private readonly assetRoot = resolveBundledCitAssetRoot()) { }

  getSpecForDocument(fileName: string, citType: CitType = "item", locale?: string): ResolvedCitSpec {
    if (isCitGlobalPropertiesFileName(fileName)) {
      return this.getGlobalSpec(locale);
    }

    return this.getCitSpec(citType, locale);
  }

  getCitSpec(citType: CitType = "item", locale?: string): ResolvedCitSpec {
    const normalizedLocale = this.normalizeLocale(locale);
    const key = `${normalizedLocale}\0cit\0${citType}`;
    const cached = this.effectiveSpecs.get(key);
    if (cached) {
      return cached;
    }

    const fragments = this.getLocaleFragments(normalizedLocale).fragments;
    const spec = mergeFragments("cit", citType, [
      requireFragment(fragments, "base"),
      requireFragment(fragments, citType)
    ]);
    this.effectiveSpecs.set(key, spec);
    return spec;
  }

  getGlobalSpec(locale?: string): ResolvedCitSpec {
    const normalizedLocale = this.normalizeLocale(locale);
    const key = `${normalizedLocale}\0global`;
    const cached = this.effectiveSpecs.get(key);
    if (cached) {
      return cached;
    }

    const fragments = this.getLocaleFragments(normalizedLocale).fragments;
    const spec = mergeFragments("global", undefined, [requireFragment(fragments, "global-properties")]);
    this.effectiveSpecs.set(key, spec);
    return spec;
  }

  getAllCitSpec(locale?: string): ResolvedCitSpec {
    const normalizedLocale = this.normalizeLocale(locale);
    const key = `${normalizedLocale}\0cit\0all`;
    const cached = this.effectiveSpecs.get(key);
    if (cached) {
      return cached;
    }

    const fragments = this.getLocaleFragments(normalizedLocale).fragments;
    const spec = mergeFragments("cit", undefined, [
      requireFragment(fragments, "base"),
      ...citTypes.map(type => requireFragment(fragments, type))
    ], true);
    this.effectiveSpecs.set(key, spec);
    return spec;
  }

  lookupKey(spec: ResolvedCitSpec, key: string): CitSpecLookupResult | null {
    const lookupKeys = getLookupKeys(key);
    for (const lookupKey of lookupKeys) {
      const exact = spec.keys.get(lookupKey);
      if (exact) {
        return { spec: exact, matchedBy: "key" };
      }
    }

    for (const candidate of spec.keys.values()) {
      for (const lookupKey of lookupKeys) {
        if (candidate.aliases?.includes(lookupKey)) {
          return { spec: candidate, matchedBy: "alias" };
        }
      }
    }

    for (const pattern of spec.patterns) {
      for (const lookupKey of lookupKeys) {
        if (matchesPattern(lookupKey, pattern.key)) {
          return { spec: pattern, matchedBy: "pattern" };
        }
      }
    }

    return null;
  }

  getKeyCompletions(spec: ResolvedCitSpec): ResolvedCitSpecKey[] {
    const completions = new Map<string, ResolvedCitSpecKey>();
    for (const key of spec.keys.values()) {
      completions.set(key.key, key);
      for (const alias of key.aliases ?? []) {
        completions.set(alias, {
          ...key,
          key: alias,
          canonicalKey: key.key
        });
      }
    }
    for (const pattern of spec.patterns) {
      completions.set(pattern.completion ?? pattern.key, {
        ...pattern,
        key: pattern.completion ?? pattern.key
      });
    }
    return [...completions.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  loadFragments(locale?: string): CitSpecFragment[] {
    return [...this.getLocaleFragments(this.normalizeLocale(locale)).fragments.values()];
  }

  private getLocaleFragments(locale: string): LocaleFragments {
    const cached = this.locales.get(locale);
    if (cached) {
      return cached;
    }

    const localeRoot = path.join(this.assetRoot, locale);
    const fallbackRoot = path.join(this.assetRoot, "en");
    const root = fs.existsSync(localeRoot) ? localeRoot : fallbackRoot;
    const fragments = new Map<string, CitSpecFragment>();

    for (const fragment of requiredFragments) {
      const fileName = path.join(root, `${fragment}.json`);
      fragments.set(fragment, readJsonFile<CitSpecFragment>(fileName));
    }

    const result = { fragments };
    this.locales.set(locale, result);
    return result;
  }

  private normalizeLocale(locale?: string): string {
    const normalized = (locale ?? "en").toLowerCase();
    if (normalized === "zh-cn" || normalized.startsWith("zh")) {
      return "zh-cn";
    }
    return "en";
  }
}

function getLookupKeys(key: string): string[] {
  const normalized = stripDefaultCitNamespace(key);
  return normalized === key ? [key] : [key, normalized];
}

export const citSpecService = new CitSpecService();

function resolveBundledCitAssetRoot(): string {
  for (const candidate of [
    path.join(__dirname, "..", "..", "..", "assets", "cit"),
    path.join(__dirname, "..", "..", "assets", "cit"),
    path.join(process.cwd(), "assets", "cit")
  ]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(process.cwd(), "assets", "cit");
}

function mergeFragments(
  scope: CitSpecScope,
  citType: CitType | undefined,
  fragments: CitSpecFragment[],
  allowCompatibleDuplicates = false
): ResolvedCitSpec {
  const keys = new Map<string, ResolvedCitSpecKey>();
  const patterns = new Map<string, ResolvedCitSpecKey>();

  for (const fragment of fragments) {
    if (fragment.scope !== scope) {
      throw new Error(`CIT spec fragment ${fragment.id} has scope ${fragment.scope}; expected ${scope}`);
    }

    mergeEntries(keys, fragment.keys, fragment.id, allowCompatibleDuplicates);
    mergeEntries(patterns, fragment.patterns, fragment.id, allowCompatibleDuplicates, true);
  }

  return {
    scope,
    citType,
    keys,
    patterns: [...patterns.values()],
    fragments: fragments.map(fragment => fragment.id)
  };
}

function mergeEntries(
  target: Map<string, ResolvedCitSpecKey>,
  entries: Record<string, CitSpecKey>,
  fragmentId: string,
  allowCompatibleDuplicates: boolean,
  pattern = false
): void {
  for (const [key, spec] of Object.entries(entries)) {
    const resolved: ResolvedCitSpecKey = {
      ...spec,
      key,
      pattern: pattern ? key : undefined
    };
    const existing = target.get(key);
    if (existing) {
      if (!allowCompatibleDuplicates || !isCompatibleDuplicate(existing, resolved)) {
        throw new Error(`Conflicting CIT spec ${pattern ? "pattern" : "key"} '${key}' in ${fragmentId}`);
      }
      continue;
    }
    target.set(key, resolved);
  }
}

function isCompatibleDuplicate(left: CitSpecKey, right: CitSpecKey): boolean {
  return left.valueType === right.valueType &&
    JSON.stringify(left.enum ?? []) === JSON.stringify(right.enum ?? []) &&
    left.assetKind === right.assetKind &&
    left.resourceKind === right.resourceKind;
}

function matchesPattern(key: string, pattern: string): boolean {
  if (!pattern.endsWith(".*")) {
    return key === pattern;
  }

  const prefix = pattern.slice(0, -1);
  return key.startsWith(prefix) && key.length > prefix.length;
}

function requireFragment(fragments: Map<string, CitSpecFragment>, id: string): CitSpecFragment {
  const fragment = fragments.get(id);
  if (!fragment) {
    throw new Error(`Missing CIT spec fragment: ${id}`);
  }
  return fragment;
}

function readJsonFile<T>(fileName: string): T {
  return JSON.parse(fs.readFileSync(fileName, "utf8")) as T;
}
