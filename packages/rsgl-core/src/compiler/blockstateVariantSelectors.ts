export interface ParsedBlockstateVariantSelector {
  readonly key: string;
  readonly assignments: ReadonlyMap<string, string>;
  readonly propertyNames: readonly string[];
}

interface SelectorSignatureGroup {
  readonly propertyNames: readonly string[];
  readonly selectors: ParsedBlockstateVariantSelector[];
  readonly projections: Map<string, SelectorProjection>;
}

interface SelectorProjection {
  readonly propertyNames: readonly string[];
  readonly firstKeyByValues: Map<string, string>;
}

/** Parses the canonical comma-separated selector representation used by blockstate JSON. */
export function parseBlockstateVariantSelector(
  key: string
): ParsedBlockstateVariantSelector | undefined {
  const assignments = new Map<string, string>();
  if (key !== "") {
    for (const part of key.split(",")) {
      const separator = part.indexOf("=");
      if (separator <= 0 || separator !== part.lastIndexOf("=")) {
        return undefined;
      }
      const name = part.slice(0, separator);
      const value = part.slice(separator + 1);
      if (!value || assignments.has(name)) {
        return undefined;
      }
      assignments.set(name, value);
    }
  }
  return {
    key,
    assignments,
    propertyNames: [...assignments.keys()].sort()
  };
}

export function blockstateVariantSelectorsOverlap(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>
): boolean {
  for (const [name, value] of left) {
    const other = right.get(name);
    if (other !== undefined && other !== value) {
      return false;
    }
  }
  return true;
}

/**
 * Finds compatible partial selectors by property-signature projections.
 * Common generated tables use one signature, making each lookup independent
 * of the number of variants instead of rescanning every earlier selector.
 */
export class BlockstateVariantSelectorIndex {
  private readonly groups = new Map<string, SelectorSignatureGroup>();

  public clear(): void {
    this.groups.clear();
  }

  public reset(keys: Iterable<string>): void {
    this.clear();
    for (const key of keys) {
      const selector = parseBlockstateVariantSelector(key);
      if (selector) {
        this.add(selector);
      }
    }
  }

  public findOverlap(selector: ParsedBlockstateVariantSelector): string | undefined {
    for (const group of this.groups.values()) {
      const sharedNames = group.propertyNames.filter(name => selector.assignments.has(name));
      const projection = this.projection(group, sharedNames);
      const valuesKey = projectionValuesKey(sharedNames, selector.assignments);
      const overlappingKey = projection.firstKeyByValues.get(valuesKey);
      if (overlappingKey !== undefined) {
        return overlappingKey;
      }
    }
    return undefined;
  }

  public add(selector: ParsedBlockstateVariantSelector): void {
    const signature = namesKey(selector.propertyNames);
    let group = this.groups.get(signature);
    if (!group) {
      group = {
        propertyNames: selector.propertyNames,
        selectors: [],
        projections: new Map()
      };
      this.groups.set(signature, group);
    }
    group.selectors.push(selector);
    for (const projection of group.projections.values()) {
      const valuesKey = projectionValuesKey(projection.propertyNames, selector.assignments);
      if (!projection.firstKeyByValues.has(valuesKey)) {
        projection.firstKeyByValues.set(valuesKey, selector.key);
      }
    }
  }

  private projection(
    group: SelectorSignatureGroup,
    names: readonly string[]
  ): SelectorProjection {
    const key = namesKey(names);
    const existing = group.projections.get(key);
    if (existing) {
      return existing;
    }
    const firstKeyByValues = new Map<string, string>();
    for (const selector of group.selectors) {
      const valuesKey = projectionValuesKey(names, selector.assignments);
      if (!firstKeyByValues.has(valuesKey)) {
        firstKeyByValues.set(valuesKey, selector.key);
      }
    }
    const projection = { propertyNames: names, firstKeyByValues };
    group.projections.set(key, projection);
    return projection;
  }
}

export interface BlockstateVariantSelectorAnalysis {
  readonly selectors: readonly ParsedBlockstateVariantSelector[];
  readonly overlaps: ReadonlyMap<string, string>;
}

/** Parses selectors and records the first overlap for each later entry in one indexed pass. */
export function analyzeBlockstateVariantSelectors(
  keys: Iterable<string>
): BlockstateVariantSelectorAnalysis {
  const index = new BlockstateVariantSelectorIndex();
  const selectors: ParsedBlockstateVariantSelector[] = [];
  const overlaps = new Map<string, string>();
  for (const key of keys) {
    const selector = parseBlockstateVariantSelector(key);
    if (!selector) {
      continue;
    }
    const overlappingKey = index.findOverlap(selector);
    if (overlappingKey !== undefined) {
      overlaps.set(key, overlappingKey);
    }
    index.add(selector);
    selectors.push(selector);
  }
  return { selectors, overlaps };
}

function namesKey(names: readonly string[]): string {
  return JSON.stringify(names);
}

function projectionValuesKey(
  names: readonly string[],
  assignments: ReadonlyMap<string, string>
): string {
  return JSON.stringify(names.map(name => assignments.get(name)));
}
