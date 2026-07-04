import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";

interface StateDomain {
  values: Set<string>;
}

interface StateConstraint {
  allowed?: Set<string>;
  denied: Set<string>;
}

interface StateTerm {
  value: string;
  negated: boolean;
}

interface BlockstateStateValidationOptions {
  rangeForGeneratedPath?: (path: string) => RsglCompileDiagnostic["range"];
}

const stateNamePattern = /^[a-z0-9_]+$/;
const stateValuePattern = /^[a-z0-9_]+$/;

export function validateBlockstateStateDomains(
  content: Record<string, JsonValue> | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  options: BlockstateStateValidationOptions = {}
): void {
  if (!content) {
    return;
  }

  const domains = new Map<string, StateDomain>();
  collectVariantStateDomains(asObject(content.variants), domains, unit, diagnostics, options);
  collectMultipartStateDomains(Array.isArray(content.multipart) ? content.multipart : [], domains, unit, diagnostics, options);
  validateInferredStateDomains(domains, unit, diagnostics);
}

function collectVariantStateDomains(
  variants: Record<string, JsonValue> | undefined,
  domains: Map<string, StateDomain>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  options: BlockstateStateValidationOptions
): void {
  if (!variants) {
    return;
  }
  for (const key of Object.keys(variants)) {
    const range = rangeForGeneratedPath(unit, options, appendGeneratedPath("/variants", key));
    for (const assignment of parseVariantStateAssignments(key)) {
      validateStateName(assignment.name, diagnostics, range);
      validateStateValue(assignment.value, diagnostics, range);
      addStateDomainValue(domains, assignment.name, assignment.value);
    }
  }
}

function collectMultipartStateDomains(
  multipart: JsonValue[],
  domains: Map<string, StateDomain>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  options: BlockstateStateValidationOptions
): void {
  for (const [index, entry] of multipart.entries()) {
    const condition = asObject(asObject(entry)?.when);
    if (condition) {
      collectWhenStateDomains(condition, domains, unit, diagnostics, rangeForGeneratedPath(unit, options, appendGeneratedPath("/multipart", String(index))));
    }
  }
}

function collectWhenStateDomains(
  condition: Record<string, JsonValue>,
  domains: Map<string, StateDomain>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  range: RsglCompileDiagnostic["range"]
): StateConstraintMap {
  const constraints: StateConstraintMap = new Map();
  for (const [key, value] of Object.entries(condition)) {
    if (key === "OR") {
      if (Array.isArray(value)) {
        for (const item of value) {
          const nested = asObject(item);
          if (nested) {
            collectWhenStateDomains(nested, domains, unit, diagnostics, range);
          }
        }
      }
      continue;
    }
    if (key === "AND") {
      if (Array.isArray(value)) {
        for (const item of value) {
          const nested = asObject(item);
          if (nested) {
            mergeAndConstraints(constraints, collectWhenStateDomains(nested, domains, unit, diagnostics, range), diagnostics, range);
          }
        }
      }
      continue;
    }

    validateStateName(key, diagnostics, range);
    const terms = parseWhenStateTerms(value, diagnostics, range);
    for (const term of terms) {
      validateStateValue(term.value, diagnostics, range);
      addStateDomainValue(domains, key, term.value);
    }
    const constraint = constraintFromTerms(terms);
    if (constraint) {
      mergeAndConstraints(constraints, new Map([[key, constraint]]), diagnostics, range);
    }
  }
  return constraints;
}

type StateConstraintMap = Map<string, StateConstraint>;

function mergeAndConstraints(
  target: StateConstraintMap,
  incoming: StateConstraintMap,
  diagnostics: RsglCompileDiagnostic[],
  range: RsglCompileDiagnostic["range"]
): void {
  for (const [name, next] of incoming) {
    const current = target.get(name);
    if (!current) {
      target.set(name, cloneConstraint(next));
      continue;
    }

    const allowed = mergeAllowedValues(current.allowed, next.allowed);
    const denied = new Set([...current.denied, ...next.denied]);
    if (
      allowed?.size === 0 ||
      (allowed && [...allowed].every(value => denied.has(value)))
    ) {
      diagnostics.push({
        code: "rsgl.contradictoryBlockstateWhenCondition",
        message: `Blockstate multipart AND condition has contradictory requirements for state '${name}'.`,
        severity: "warning",
        range
      });
    }
    target.set(name, { allowed, denied });
  }
}

function mergeAllowedValues(left: Set<string> | undefined, right: Set<string> | undefined): Set<string> | undefined {
  if (!left && !right) {
    return undefined;
  }
  if (!left) {
    return new Set(right);
  }
  if (!right) {
    return new Set(left);
  }
  return new Set([...left].filter(value => right.has(value)));
}

function cloneConstraint(value: StateConstraint): StateConstraint {
  return {
    allowed: value.allowed ? new Set(value.allowed) : undefined,
    denied: new Set(value.denied)
  };
}

function constraintFromTerms(terms: StateTerm[]): StateConstraint | undefined {
  if (terms.length === 0) {
    return undefined;
  }
  if (terms.every(term => !term.negated)) {
    return { allowed: new Set(terms.map(term => term.value)), denied: new Set() };
  }
  if (terms.length === 1 && terms[0].negated) {
    return { denied: new Set([terms[0].value]) };
  }
  return undefined;
}

function parseVariantStateAssignments(key: string): Array<{ name: string; value: string }> {
  if (key === "") {
    return [];
  }
  const assignments: Array<{ name: string; value: string }> = [];
  for (const part of key.split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex !== part.lastIndexOf("=")) {
      continue;
    }
    assignments.push({
      name: part.slice(0, separatorIndex),
      value: part.slice(separatorIndex + 1)
    });
  }
  return assignments;
}

function parseWhenStateTerms(
  value: JsonValue,
  diagnostics: RsglCompileDiagnostic[],
  range: RsglCompileDiagnostic["range"]
): StateTerm[] {
  if (typeof value === "boolean" || typeof value === "number") {
    return [{ value: String(value), negated: false }];
  }
  if (typeof value !== "string") {
    return [];
  }

  const terms = value.split("|")
    .filter(part => part.length > 0)
    .map(part => part.startsWith("!")
      ? { value: part.slice(1), negated: true }
      : { value: part, negated: false });
  reportDuplicateWhenTerms(terms, diagnostics, range);
  reportTautologicalWhenTerms(terms, diagnostics, range);
  return terms;
}

function reportDuplicateWhenTerms(
  terms: StateTerm[],
  diagnostics: RsglCompileDiagnostic[],
  range: RsglCompileDiagnostic["range"]
): void {
  const seen = new Set<string>();
  for (const term of terms) {
    const key = `${term.negated ? "!" : ""}${term.value}`;
    if (seen.has(key)) {
      diagnostics.push({
        code: "rsgl.duplicateBlockstateWhenValue",
        message: `Blockstate multipart when value '${key}' is repeated in the same state condition.`,
        severity: "warning",
        range
      });
      return;
    }
    seen.add(key);
  }
}

function reportTautologicalWhenTerms(
  terms: StateTerm[],
  diagnostics: RsglCompileDiagnostic[],
  range: RsglCompileDiagnostic["range"]
): void {
  const positives = new Set(terms.filter(term => !term.negated).map(term => term.value));
  if (terms.some(term => term.negated && positives.has(term.value))) {
    diagnostics.push({
      code: "rsgl.tautologicalBlockstateWhenValue",
      message: "Blockstate multipart when value includes both a state value and its negation.",
      severity: "warning",
      range
    });
  }
}

function validateStateName(
  name: string,
  diagnostics: RsglCompileDiagnostic[],
  range: RsglCompileDiagnostic["range"]
): void {
  if (stateNamePattern.test(name)) {
    return;
  }
  diagnostics.push({
    code: "rsgl.invalidBlockstateStateProperty",
    message: `Blockstate state property '${name}' must use lowercase letters, digits, or underscores.`,
    severity: "error",
    range
  });
}

function validateStateValue(
  value: string,
  diagnostics: RsglCompileDiagnostic[],
  range: RsglCompileDiagnostic["range"]
): void {
  if (stateValuePattern.test(value)) {
    return;
  }
  diagnostics.push({
    code: "rsgl.invalidBlockstateStateValue",
    message: `Blockstate state value '${value}' must use lowercase letters, digits, or underscores.`,
    severity: "error",
    range
  });
}

function addStateDomainValue(domains: Map<string, StateDomain>, name: string, value: string): void {
  let domain = domains.get(name);
  if (!domain) {
    domain = { values: new Set() };
    domains.set(name, domain);
  }
  domain.values.add(value);
}

function validateInferredStateDomains(
  domains: Map<string, StateDomain>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  for (const [name, domain] of domains) {
    const values = [...domain.values];
    if (
      values.some(value => value === "true" || value === "false") &&
      values.some(value => value !== "true" && value !== "false")
    ) {
      diagnostics.push({
        code: "rsgl.mixedBlockstateStateValueDomain",
        message: `Blockstate state '${name}' mixes boolean values with non-boolean values.`,
        severity: "warning",
        range: unitRange(unit)
      });
    }
  }
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function rangeForGeneratedPath(
  unit: ResourceUnit,
  options: BlockstateStateValidationOptions,
  generatedPath: string
): RsglCompileDiagnostic["range"] {
  return options.rangeForGeneratedPath?.(generatedPath) ?? unitRange(unit);
}

function unitRange(unit: ResourceUnit): { start: number; end: number } {
  return unit.sourceMap.mappings[0]?.sourceRange ?? { start: 0, end: 1 };
}
