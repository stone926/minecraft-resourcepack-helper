import type { JsonValue } from "./ir";

export interface LegacyItemPropertyOptionIssue {
  field: string;
  message: string;
}

export interface LegacyRangePropertyConfiguration {
  predicate: string;
  /** Modern range thresholds are divided by this positive scale. */
  thresholdScale: number;
}

export interface LegacyRangePropertyResolution {
  configuration?: LegacyRangePropertyConfiguration;
  issues: LegacyItemPropertyOptionIssue[];
}

/**
 * Resolves only property configurations whose observable behavior can be
 * encoded by a legacy model predicate. Unsupported inline options are
 * returned separately so the backend can diagnose their exact source paths.
 */
export function resolveLegacyRangeProperty(
  model: Record<string, JsonValue>
): LegacyRangePropertyResolution {
  const property = normalizedProperty(model.property);
  const predicate = legacyRangePredicate(property);
  if (!predicate) {
    return {
      issues: [{
        field: "property",
        message: "Legacy range_dispatch lowering does not support property '" + String(model.property) + "'."
      }]
    };
  }

  const issues: LegacyItemPropertyOptionIssue[] = [];
  const scale = Object.hasOwn(model, "scale") ? model.scale : 1;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) {
    issues.push({
      field: "scale",
      message: "Legacy range_dispatch lowering requires 'scale' to be a positive finite number."
    });
  }

  if (property === "custom_model_data") {
    requireDefaultOption(model, "index", 0, issues);
  } else if (property === "damage") {
    requireDefaultOption(model, "normalize", true, issues);
  } else if (property === "compass") {
    issues.push({
      field: "target",
      message: "Legacy item predicate 'angle' cannot encode the minecraft:compass 'target' option."
    });
    requireDefaultOption(model, "wobble", true, issues);
  } else if (property === "time") {
    if (Object.hasOwn(model, "source")) {
      issues.push({
        field: "source",
        message: "Legacy item predicate 'time' cannot encode the minecraft:time 'source' option."
      });
    }
    requireDefaultOption(model, "natural_only", true, issues);
    requireDefaultOption(model, "wobble", true, issues);
  }

  return issues.length === 0 && typeof scale === "number"
    ? { configuration: { predicate, thresholdScale: scale }, issues }
    : { issues };
}

/** Only the first migrated custom-model-data slot exists in legacy models. */
export function legacySelectPropertyOptionIssues(
  model: Record<string, JsonValue>
): LegacyItemPropertyOptionIssue[] {
  if (normalizedProperty(model.property) !== "custom_model_data") {
    return [];
  }
  const issues: LegacyItemPropertyOptionIssue[] = [];
  requireDefaultOption(model, "index", 0, issues);
  return issues;
}

function requireDefaultOption(
  model: Record<string, JsonValue>,
  field: string,
  expected: JsonValue,
  issues: LegacyItemPropertyOptionIssue[]
): void {
  if (!Object.hasOwn(model, field) || model[field] === expected) {
    return;
  }
  issues.push({
    field,
    message: "Legacy item predicates can only represent '" + field + "' with its default value "
      + JSON.stringify(expected) + "."
  });
}

function legacyRangePredicate(property: string | null): string | null {
  if (property === "custom_model_data") {
    return "custom_model_data";
  }
  if (
    property === "damage"
    || property === "damaged"
    || property === "pull"
    || property === "pulling"
    || property === "blocking"
    || property === "cooldown"
  ) {
    return property;
  }
  if (property === "crossbow/pull") {
    return "pull";
  }
  if (property === "compass") {
    return "angle";
  }
  if (property === "time") {
    return "time";
  }
  return null;
}

function normalizedProperty(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value.replace(/^minecraft:/, "") : null;
}
