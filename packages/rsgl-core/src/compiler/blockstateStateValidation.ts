import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import { pushDiagnosticAtRange, unitRange } from "./validationDiagnostics";
import { asObject } from "./validationPrimitives";
import type { RsglBlockstateSchema } from "./validationTypes";

export type { RsglBlockstateSchema } from "./validationTypes";

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
  schema?: RsglBlockstateSchema | null;
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
  collectVariantStateDomains(asObject(content.variants) ?? undefined, domains, unit, diagnostics, options);
  collectMultipartStateDomains(Array.isArray(content.multipart) ? content.multipart : [], domains, unit, diagnostics, options);
  validateInferredStateDomains(domains, unit, diagnostics);
}

export function inferBlockstateSchemaFromContent(content: JsonValue | undefined): RsglBlockstateSchema | null {
  const object = asObject(content);
  if (!object) {
    return null;
  }

  const domains = new Map<string, StateDomain>();
  collectSchemaVariantDomains(asObject(object.variants) ?? undefined, domains);
  collectSchemaMultipartDomains(Array.isArray(object.multipart) ? object.multipart : [], domains);
  if (domains.size === 0) {
    return null;
  }

  const properties: Record<string, string[]> = {};
  for (const [name, domain] of [...domains].sort(([left], [right]) => left.localeCompare(right))) {
    properties[name] = [...domain.values].sort();
  }
  return { properties };
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
      const validName = validateStateName(assignment.name, diagnostics, range);
      const validValue = validateStateValue(assignment.value, diagnostics, range);
      if (validName && validValue) {
        validateStateAgainstSchema(assignment.name, assignment.value, options.schema, diagnostics, range);
      }
      addStateDomainValue(domains, assignment.name, assignment.value);
    }
  }
}

function collectSchemaVariantDomains(
  variants: Record<string, JsonValue> | undefined,
  domains: Map<string, StateDomain>
): void {
  if (!variants) {
    return;
  }
  for (const key of Object.keys(variants)) {
    for (const assignment of parseVariantStateAssignments(key)) {
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
      collectWhenStateDomains(condition, domains, unit, diagnostics, rangeForGeneratedPath(unit, options, appendGeneratedPath("/multipart", String(index))), options.schema);
    }
  }
}

function collectSchemaMultipartDomains(
  multipart: JsonValue[],
  domains: Map<string, StateDomain>
): void {
  for (const entry of multipart) {
    const condition = asObject(asObject(entry)?.when);
    if (condition) {
      collectSchemaWhenStateDomains(condition, domains);
    }
  }
}

function collectSchemaWhenStateDomains(
  condition: Record<string, JsonValue>,
  domains: Map<string, StateDomain>
): void {
  for (const [key, value] of Object.entries(condition)) {
    if (key === "OR" || key === "AND") {
      if (Array.isArray(value)) {
        for (const item of value) {
          const nested = asObject(item);
          if (nested) {
            collectSchemaWhenStateDomains(nested, domains);
          }
        }
      }
      continue;
    }

    for (const term of parseSchemaWhenStateTerms(value)) {
      addStateDomainValue(domains, key, term);
    }
  }
}

function collectWhenStateDomains(
  condition: Record<string, JsonValue>,
  domains: Map<string, StateDomain>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  range: RsglCompileDiagnostic["range"],
  schema: RsglBlockstateSchema | null | undefined
): StateConstraintMap {
  const constraints: StateConstraintMap = new Map();
  for (const [key, value] of Object.entries(condition)) {
    if (key === "OR") {
      if (Array.isArray(value)) {
        for (const item of value) {
          const nested = asObject(item);
          if (nested) {
            collectWhenStateDomains(nested, domains, unit, diagnostics, range, schema);
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
            mergeAndConstraints(constraints, collectWhenStateDomains(nested, domains, unit, diagnostics, range, schema), diagnostics, range);
          }
        }
      }
      continue;
    }

    const terms = parseWhenStateTerms(value, diagnostics, range);
    const validName = validateStateName(key, diagnostics, range);
    for (const term of terms) {
      const validValue = validateStateValue(term.value, diagnostics, range);
      if (validName && validValue) {
        validateStateAgainstSchema(key, term.value, schema, diagnostics, range);
      }
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
      pushDiagnosticAtRange(
        diagnostics,
        "rsgl.contradictoryBlockstateWhenCondition",
        `Blockstate multipart AND condition has contradictory requirements for state '${name}'.`,
        "warning",
        range
      );
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

function parseSchemaWhenStateTerms(value: JsonValue): string[] {
  if (typeof value === "boolean" || typeof value === "number") {
    return [String(value)];
  }
  if (typeof value !== "string") {
    return [];
  }
  return value.split("|")
    .filter(part => part.length > 0)
    .map(part => part.startsWith("!") ? part.slice(1) : part)
    .filter(part => part.length > 0);
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
      pushDiagnosticAtRange(
        diagnostics,
        "rsgl.duplicateBlockstateWhenValue",
        `Blockstate multipart when value '${key}' is repeated in the same state condition.`,
        "warning",
        range
      );
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
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.tautologicalBlockstateWhenValue",
      "Blockstate multipart when value includes both a state value and its negation.",
      "warning",
      range
    );
  }
}

function validateStateName(
  name: string,
  diagnostics: RsglCompileDiagnostic[],
  range: RsglCompileDiagnostic["range"]
): boolean {
  if (stateNamePattern.test(name)) {
    return true;
  }
  pushDiagnosticAtRange(
    diagnostics,
    "rsgl.invalidBlockstateStateProperty",
    `Blockstate state property '${name}' must use lowercase letters, digits, or underscores.`,
    "error",
    range
  );
  return false;
}

function validateStateValue(
  value: string,
  diagnostics: RsglCompileDiagnostic[],
  range: RsglCompileDiagnostic["range"]
): boolean {
  if (stateValuePattern.test(value)) {
    return true;
  }
  pushDiagnosticAtRange(
    diagnostics,
    "rsgl.invalidBlockstateStateValue",
    `Blockstate state value '${value}' must use lowercase letters, digits, or underscores.`,
    "error",
    range
  );
  return false;
}

function validateStateAgainstSchema(
  name: string,
  value: string,
  schema: RsglBlockstateSchema | null | undefined,
  diagnostics: RsglCompileDiagnostic[],
  range: RsglCompileDiagnostic["range"]
): void {
  if (!schema) {
    return;
  }
  const allowedValues = schema.properties[name];
  if (!allowedValues) {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.unknownBlockstateStateProperty",
      `Blockstate state property '${name}' is not defined by the block schema.`,
      "error",
      range
    );
    return;
  }
  if (!allowedValues.includes(value)) {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.invalidBlockstateStateSchemaValue",
      `Blockstate state '${name}' does not allow value '${value}'.`,
      "error",
      range
    );
  }
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
      pushDiagnosticAtRange(
        diagnostics,
        "rsgl.mixedBlockstateStateValueDomain",
        `Blockstate state '${name}' mixes boolean values with non-boolean values.`,
        "warning",
        unitRange(unit)
      );
    }
  }
}

function rangeForGeneratedPath(
  unit: ResourceUnit,
  options: BlockstateStateValidationOptions,
  generatedPath: string
): RsglCompileDiagnostic["range"] {
  return options.rangeForGeneratedPath?.(generatedPath) ?? unitRange(unit);
}
