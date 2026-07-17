import type { ExprNode, TextRange } from "../parser";
import { consumeEvaluationItems } from "./evaluationItemAccounting";
import { normalizeJsonValue } from "./evaluationJsonValues";
import type { EvaluationRuntimeHost } from "./evaluationRuntimeHost";
import type {
  EvaluationContext,
  EvaluationValue,
  LambdaValue
} from "./evaluationTypes";
import { evaluationScalarText } from "./evaluatedResourceValues";
import type { JsonValue } from "./ir";
import { evaluateLambdaCall, isLambdaValue } from "./lambdaEvaluation";
import {
  expandSequencePattern,
  formatSequenceNumber,
  sequencePadWidth,
  sequencePatternExpansionCount
} from "./sequences";

interface SeqGenerator {
  name: string;
  iterable: ExprNode;
}

export function evaluateSeqExpression(
  expression: Extract<ExprNode, { kind: "CallExpr" }>,
  context: EvaluationContext,
  host: EvaluationRuntimeHost
): EvaluationValue {
  const patternArg = expression.args.find(arg => arg.name?.text === "pattern")
    ?? expression.args.filter(arg => !arg.name)[0];
  if (!patternArg) {
    return [];
  }

  const padArg = expression.args.find(arg => arg.name?.text === "pad");
  const padWidth = padArg
    ? sequencePadWidth(host.evaluateExpression(padArg.value, context))
    : null;
  const generatorArgs = expression.args.filter(arg => arg !== patternArg && arg !== padArg);
  const positionalGeneratorArgs = generatorArgs.filter(arg => !arg.name);
  const positionalGenerators = positionalGeneratorArgs
    .map(arg => arg.value)
    .filter((value): value is Extract<ExprNode, { kind: "ForInExpr" }> => value.kind === "ForInExpr")
    .map(value => ({ name: value.binding.text, iterable: value.iterable }));
  const namedGenerators = generatorArgs
    .filter(arg => arg.name)
    .map(arg => ({ name: arg.name!.text, iterable: arg.value }));
  const generators = [...positionalGenerators, ...namedGenerators];
  if (generators.length === 0) {
    const patternValue = host.evaluateExpression(patternArg.value, context);
    if (isLambdaValue(patternValue)) {
      const value = evaluateLambdaCall(patternValue, 0, [], context, host);
      return expandSequencePatternWithinBudget(
        scalarText(value) ?? "",
        padWidth,
        context,
        expression.range
      );
    }
    return expandSequencePatternWithinBudget(
      scalarText(patternValue) ?? "",
      padWidth,
      context,
      expression.range
    );
  }
  if (positionalGenerators.length !== positionalGeneratorArgs.length) {
    return [];
  }

  const lambdaPattern = evaluateSeqLambdaPattern(patternArg.value, context, host);
  if (!lambdaPattern) {
    return [];
  }

  return evaluateSeqGeneratorPatterns(
    lambdaPattern,
    patternArg.value.range,
    generators,
    context,
    0,
    [],
    padWidth,
    host
  );
}

function evaluateSeqGeneratorPatterns(
  lambdaPattern: LambdaValue,
  patternRange: TextRange,
  generators: SeqGenerator[],
  context: EvaluationContext,
  index: number,
  boundValues: EvaluationValue[],
  padWidth: number | null,
  host: EvaluationRuntimeHost
): string[] | undefined {
  if (index >= generators.length) {
    const args = boundValues.map(value => ({ value, range: patternRange }));
    const value = evaluateLambdaCall(lambdaPattern, boundValues.length, args, context, host);
    return expandSequencePatternWithinBudget(
      scalarText(value) ?? "",
      padWidth,
      context,
      patternRange
    );
  }

  const generator = generators[index];
  const iterable = host.evaluateExpression(generator.iterable, context);
  if (!Array.isArray(iterable)) {
    return [];
  }

  const results: string[] = [];
  for (const value of iterable) {
    const name = generator.name;
    const bindingValue = sequenceBindingValue(value, padWidth);
    const child = host.childEvaluationContext(context, { [name]: bindingValue });
    const expanded = evaluateSeqGeneratorPatterns(
      lambdaPattern,
      patternRange,
      generators,
      child,
      index + 1,
      [...boundValues, bindingValue],
      padWidth,
      host
    );
    if (!expanded) {
      return undefined;
    }
    results.push(...expanded);
  }
  return results;
}

export function expandSequencePatternWithinBudget(
  pattern: string,
  pad: number | null,
  context: EvaluationContext,
  range: TextRange
): string[] | undefined {
  const itemCount = sequencePatternExpansionCount(pattern);
  if (!consumeEvaluationItems(context, itemCount, range, "seq")) {
    return undefined;
  }
  return expandSequencePattern(pattern, { pad });
}

function evaluateSeqLambdaPattern(
  pattern: ExprNode,
  context: EvaluationContext,
  host: EvaluationRuntimeHost
): LambdaValue | null {
  if (pattern.kind !== "LambdaExpr" && pattern.kind !== "IdentifierExpr") {
    return null;
  }
  const value = host.evaluateExpression(pattern, context);
  return isLambdaValue(value) ? value : null;
}

function sequenceBindingValue(value: JsonValue, padWidth: number | null): JsonValue {
  return padWidth !== null && typeof value === "number" && Number.isFinite(value)
    ? formatSequenceNumber(value, padWidth)
    : normalizeJsonValue(value);
}

function scalarText(value: EvaluationValue): string | null {
  return evaluationScalarText(value);
}
