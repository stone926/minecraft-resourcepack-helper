import type { ExprNode, TextRange } from "../parser";
import { uniqueValues } from "../../../mc-assets/src";
import {
  analyzeBlockstatePredicateExpression,
  MAX_BLOCKSTATE_PREDICATE_DEPTH,
  MAX_BLOCKSTATE_PREDICATE_NODES
} from "../blockstatePredicateComplexity";
import type {
  EvaluationContext,
  EvaluationOrigin,
  EvaluationPathOrigin,
  EvaluationResult,
  EvaluationValue
} from "./evaluationTypes";
import type { JsonValue } from "./ir";
import type { RsglCompileContext } from "./templateExpansion";

const stateValueBrand: unique symbol = Symbol("rsgl.stateValue");

export interface StateNamespaceValue {
  readonly kind: "rsgl.stateNamespace";
  readonly [stateValueBrand]: "namespace";
}

export interface StatePropertyValue {
  readonly kind: "rsgl.stateProperty";
  readonly [stateValueBrand]: "property";
  readonly property: string;
}

export interface StatePredicateValue {
  readonly kind: "rsgl.statePredicate";
  readonly [stateValueBrand]: "predicate";
  readonly predicate: StatePredicateIr;
}

export type StatePredicateIr =
  | {
      readonly kind: "atom";
      readonly property: string;
      readonly values: readonly string[];
      readonly mode: "include" | "exclude";
    }
  | {
      readonly kind: "and" | "or";
      readonly terms: readonly StatePredicateIr[];
    }
  | {
      readonly kind: "not";
      readonly operand: StatePredicateIr;
    };

export interface LoweredBlockstatePredicate {
  readonly value: JsonValue;
  readonly canonicalKey: string;
  readonly origin?: EvaluationOrigin;
}

export interface BlockstatePredicateLoweringHost {
  onError(
    code: string,
    message: string,
    range: TextRange,
    fileName?: string
  ): void;
}

/**
 * Evaluator capabilities required by predicate lowering.
 *
 * Keeping this boundary explicit prevents the evaluator and the predicate
 * runtime from importing each other during module initialization.
 */
export interface BlockstatePredicateEvaluationHost {
  evaluateExpressionResult(
    expression: ExprNode,
    context: EvaluationContext
  ): EvaluationResult;
  originForEvaluationPath(
    origins: readonly EvaluationPathOrigin[],
    generatedPath: string
  ): EvaluationOrigin | undefined;
}

export const stateNamespaceValue: StateNamespaceValue = Object.freeze<StateNamespaceValue>({
  kind: "rsgl.stateNamespace",
  [stateValueBrand]: "namespace"
});

export function isStateNamespaceValue(value: unknown): value is StateNamespaceValue {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Partial<StateNamespaceValue>)[stateValueBrand] === "namespace"
  );
}

export function isStatePropertyValue(value: unknown): value is StatePropertyValue {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Partial<StatePropertyValue>)[stateValueBrand] === "property"
    && typeof (value as Partial<StatePropertyValue>).property === "string"
  );
}

export function isStatePredicateValue(value: unknown): value is StatePredicateValue {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Partial<StatePredicateValue>)[stateValueBrand] === "predicate"
  );
}

export function statePropertyValue(
  property: EvaluationValue,
  context: EvaluationContext,
  range: TextRange
): StatePropertyValue | undefined {
  const text = stateScalarText(property);
  if (!text || !/^[a-z0-9_]+$/.test(text)) {
    reportPredicateRuntimeError(
      context,
      "rsgl.invalidBlockstatePredicateProperty",
      "A $state property name must evaluate to lowercase letters, digits, or underscores.",
      range
    );
    return undefined;
  }
  return { kind: "rsgl.stateProperty", [stateValueBrand]: "property", property: text };
}

/** Rejects pathological predicate ASTs before the recursive evaluator touches them. */
export function preflightStatePredicateExpression(
  expression: ExprNode,
  context: EvaluationContext
): boolean {
  const complexity = analyzeBlockstatePredicateExpression(expression);
  if (complexity.withinLimit) {
    return true;
  }
  reportPredicateRuntimeError(
    context,
    "rsgl.blockstatePredicateTooComplex",
    complexity.nodes > MAX_BLOCKSTATE_PREDICATE_NODES
      ? `StatePredicate contains more than ${MAX_BLOCKSTATE_PREDICATE_NODES} expression nodes.`
      : `StatePredicate nesting exceeds the safe depth of ${MAX_BLOCKSTATE_PREDICATE_DEPTH}.`,
    expression.range
  );
  return false;
}

export function evaluateStatePredicateBinary(
  operator: string,
  left: EvaluationValue,
  right: EvaluationValue,
  context: EvaluationContext,
  range: TextRange
): { handled: boolean; value: EvaluationValue } {
  if (operator === "&&" || operator === "||") {
    if (!isStatePredicateValue(left) && !isStatePredicateValue(right)) {
      return { handled: false, value: undefined };
    }
    if (!isStatePredicateValue(left) || !isStatePredicateValue(right)) {
      reportPredicateRuntimeError(
        context,
        "rsgl.invalidBlockstatePredicate",
        `Both sides of StatePredicate '${operator}' must be StatePredicate values.`,
        range
      );
      return { handled: true, value: undefined };
    }
    return {
      handled: true,
      value: predicateValue({
        kind: operator === "&&" ? "and" : "or",
        terms: [left.predicate, right.predicate]
      })
    };
  }

  if (!isStatePropertyValue(left)) {
    return { handled: false, value: undefined };
  }
  if (operator !== "==" && operator !== "!=" && operator !== "in" && operator !== "not in") {
    reportPredicateRuntimeError(
      context,
      "rsgl.invalidBlockstatePredicate",
      `Operator '${operator}' cannot be applied to a $state property.`,
      range
    );
    return { handled: true, value: undefined };
  }

  const rawValues = operator === "in" || operator === "not in"
    ? Array.isArray(right) ? right : undefined
    : [right];
  if (!rawValues || rawValues.length === 0) {
    reportPredicateRuntimeError(
      context,
      "rsgl.invalidBlockstatePredicateMembership",
      "StatePredicate membership requires a non-empty List or Range.",
      range
    );
    return { handled: true, value: undefined };
  }

  const values: string[] = [];
  for (const candidate of rawValues) {
    const text = stateScalarText(candidate as EvaluationValue);
    if (!text || !/^[a-z0-9_]+$/.test(text)) {
      reportPredicateRuntimeError(
        context,
        "rsgl.unlowerableBlockstatePredicate",
        "StatePredicate values must lower to lowercase state atoms without '!' or '|'.",
        range
      );
      return { handled: true, value: undefined };
    }
    values.push(text);
  }

  return {
    handled: true,
    value: predicateValue({
      kind: "atom",
      property: left.property,
      values: uniqueValues(values),
      mode: operator === "!=" || operator === "not in" ? "exclude" : "include"
    })
  };
}

export function evaluateStatePredicateUnary(
  operator: string,
  value: EvaluationValue,
  context: EvaluationContext,
  range: TextRange
): { handled: boolean; value: EvaluationValue } {
  if (!isStatePredicateValue(value)) {
    return { handled: false, value: undefined };
  }
  if (operator !== "!") {
    reportPredicateRuntimeError(
      context,
      "rsgl.invalidBlockstatePredicate",
      `Unary '${operator}' is not valid for StatePredicate.`,
      range
    );
    return { handled: true, value: undefined };
  }
  return {
    handled: true,
    value: predicateValue({ kind: "not", operand: value.predicate })
  };
}

export function lowerBlockstatePredicate(
  expression: ExprNode,
  context: RsglCompileContext,
  host: BlockstatePredicateLoweringHost,
  evaluationHost: BlockstatePredicateEvaluationHost
): LoweredBlockstatePredicate | undefined {
  let failed = false;
  const result = evaluationHost.evaluateExpressionResult(expression, {
    ...context,
    onEvaluationFailure: () => {
      failed = true;
      context.onEvaluationFailure?.();
    }
  });
  if (failed || !isStatePredicateValue(result.value)) {
    if (!failed) {
      host.onError(
        "rsgl.invalidBlockstatePredicate",
        "A multipart 'part when' expression must evaluate to StatePredicate.",
        expression.range,
        context.sourceFile
      );
    }
    return undefined;
  }

  const inputComplexity = predicateIrComplexity(result.value.predicate);
  if (!inputComplexity.valid) {
    host.onError(
      "rsgl.unlowerableBlockstatePredicate",
      "StatePredicate runtime data is malformed and cannot be lowered safely.",
      expression.range,
      context.sourceFile
    );
    return undefined;
  }
  if (
    inputComplexity.nodes > MAX_BLOCKSTATE_PREDICATE_NODES
    || inputComplexity.depth > MAX_BLOCKSTATE_PREDICATE_DEPTH
  ) {
    host.onError(
      "rsgl.blockstatePredicateTooComplex",
      `StatePredicate lowering exceeds the ${MAX_BLOCKSTATE_PREDICATE_NODES}-node or ${MAX_BLOCKSTATE_PREDICATE_DEPTH}-depth safety limit.`,
      expression.range,
      context.sourceFile
    );
    return undefined;
  }

  const normalized = normalizePredicate(result.value.predicate);
  const nodeCount = predicateNodeCount(normalized);
  if (nodeCount > MAX_BLOCKSTATE_PREDICATE_NODES) {
    host.onError(
      "rsgl.blockstatePredicateTooComplex",
      `StatePredicate lowering would require ${nodeCount} condition nodes; the limit is ${MAX_BLOCKSTATE_PREDICATE_NODES}.`,
      expression.range,
      context.sourceFile
    );
    return undefined;
  }

  const value = lowerPredicateIr(normalized);
  const rootOrigin = evaluationHost.originForEvaluationPath(result.pathOrigins, "")
    ?? result.origin;
  return {
    value,
    canonicalKey: canonicalJson(value),
    ...(rootOrigin ? { origin: rootOrigin } : {})
  };
}

function predicateValue(predicate: StatePredicateIr): StatePredicateValue {
  return { kind: "rsgl.statePredicate", [stateValueBrand]: "predicate", predicate };
}

function normalizePredicate(
  predicate: StatePredicateIr,
  negated = false
): StatePredicateIr {
  if (predicate.kind === "not") {
    return normalizePredicate(predicate.operand, !negated);
  }
  if (predicate.kind === "atom") {
    return {
      ...predicate,
      values: [...predicate.values],
      mode: negated
        ? predicate.mode === "include" ? "exclude" : "include"
        : predicate.mode
    };
  }

  const kind = negated
    ? predicate.kind === "and" ? "or" : "and"
    : predicate.kind;
  const terms = predicate.terms.flatMap(term => {
    const normalized = normalizePredicate(term, negated);
    return normalized.kind === kind ? normalized.terms : [normalized];
  });
  return {
    kind,
    terms: [...terms].sort((left, right) =>
      canonicalPredicateIr(left).localeCompare(canonicalPredicateIr(right))
    )
  };
}

function lowerPredicateIr(predicate: StatePredicateIr): JsonValue {
  if (predicate.kind === "not") {
    return lowerPredicateIr(normalizePredicate(predicate));
  }
  if (predicate.kind === "atom") {
    if (predicate.mode === "include") {
      return { [predicate.property]: predicate.values.join("|") };
    }
    if (predicate.values.length === 1) {
      return { [predicate.property]: `!${predicate.values[0]}` };
    }
    return {
      AND: predicate.values.map(value => ({
        [predicate.property]: `!${value}`
      }))
    };
  }

  const terms = predicate.terms.map(lowerPredicateIr);
  if (predicate.kind === "or") {
    const merged = mergeSamePropertyIncludes(predicate.terms);
    return merged ?? { OR: terms };
  }
  const merged = mergeDistinctPropertyObjects(terms);
  return merged ?? { AND: terms };
}

function mergeSamePropertyIncludes(terms: readonly StatePredicateIr[]): JsonValue | undefined {
  if (terms.length === 0 || !terms.every(term =>
    term.kind === "atom" && term.mode === "include"
  )) {
    return undefined;
  }
  const atoms = terms as Array<Extract<StatePredicateIr, { kind: "atom" }>>;
  const property = atoms[0].property;
  if (!atoms.every(atom => atom.property === property)) {
    return undefined;
  }
  const values = uniqueValues(atoms.flatMap(atom => atom.values));
  return { [property]: values.join("|") };
}

function mergeDistinctPropertyObjects(terms: readonly JsonValue[]): JsonValue | undefined {
  const result: Record<string, JsonValue> = {};
  for (const term of terms) {
    if (!term || typeof term !== "object" || Array.isArray(term)) {
      return undefined;
    }
    const entries = Object.entries(term);
    if (entries.some(([key]) => key === "AND" || key === "OR" || key in result)) {
      return undefined;
    }
    Object.assign(result, term);
  }
  return result;
}

function predicateNodeCount(predicate: StatePredicateIr): number {
  if (predicate.kind === "atom") {
    return predicate.mode === "exclude" && predicate.values.length > 1
      ? 1 + predicate.values.length
      : 1;
  }
  if (predicate.kind === "not") {
    return 1 + predicateNodeCount(predicate.operand);
  }
  return 1 + predicate.terms.reduce((sum, term) => sum + predicateNodeCount(term), 0);
}

function canonicalPredicateIr(predicate: StatePredicateIr): string {
  if (predicate.kind === "atom") {
    return `${predicate.mode}:${predicate.property}:${[...predicate.values].sort().join("|")}`;
  }
  if (predicate.kind === "not") {
    return `not(${canonicalPredicateIr(predicate.operand)})`;
  }
  return `${predicate.kind}(${predicate.terms.map(canonicalPredicateIr).sort().join(",")})`;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).sort().join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function predicateIrComplexity(root: StatePredicateIr): {
  valid: boolean;
  nodes: number;
  depth: number;
} {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 1 }];
  let nodes = 0;
  let depth = 0;
  while (stack.length > 0 && nodes <= MAX_BLOCKSTATE_PREDICATE_NODES) {
    const { value, depth: currentDepth } = stack.pop()!;
    nodes += 1;
    depth = Math.max(depth, currentDepth);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { valid: false, nodes, depth };
    }
    const candidate = value as Partial<StatePredicateIr> & Record<string, unknown>;
    if (candidate.kind === "atom") {
      if (
        typeof candidate.property !== "string"
        || (candidate.mode !== "include" && candidate.mode !== "exclude")
        || !Array.isArray(candidate.values)
        || candidate.values.length === 0
        || !candidate.values.every(item => typeof item === "string")
      ) {
        return { valid: false, nodes, depth };
      }
      continue;
    }
    if (candidate.kind === "not") {
      stack.push({ value: candidate.operand, depth: currentDepth + 1 });
      continue;
    }
    if (candidate.kind === "and" || candidate.kind === "or") {
      if (!Array.isArray(candidate.terms) || candidate.terms.length === 0) {
        return { valid: false, nodes, depth };
      }
      candidate.terms.forEach(term => stack.push({ value: term, depth: currentDepth + 1 }));
      continue;
    }
    return { valid: false, nodes, depth };
  }
  return { valid: true, nodes, depth };
}

function stateScalarText(value: EvaluationValue): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function reportPredicateRuntimeError(
  context: EvaluationContext,
  code: string,
  message: string,
  range: TextRange
): void {
  context.onEvaluationFailure?.();
  context.onError?.(code, message, range, context.sourceFile);
}
