import type { ExprNode, TextRange } from "../parser";
import type { EvaluationContext } from "./evaluate";
import { evaluatedPathOrigins } from "./evaluationProvenance";
import type { RsglResourceValueObservation } from "./evaluatedResourceValues";
import type { ItemModelExecutorHost, LoweredItemModel } from "./itemModelExecutorTypes";
import {
  evaluateJsonExpressionWithResult,
  type EvaluatedJsonExpression
} from "./jsonValueLowerer";
import type { ResourceBodyMapping } from "./resourceBody";
import { appendGeneratedPath } from "./sourcePaths";
import type { RsglCompileContext } from "./templateExpansion";

export interface CapturedItemModelExpression {
  readonly evaluated: EvaluatedJsonExpression;
  readonly observations: readonly RsglResourceValueObservation[];
}

/** Evaluates a JSON expression while deferring resource observations until lowering succeeds. */
export function evaluateCapturedItemModelExpression(
  expression: ExprNode,
  context: RsglCompileContext,
  host: ItemModelExecutorHost,
  generatedPath: string
): CapturedItemModelExpression | undefined {
  const observations: RsglResourceValueObservation[] = [];
  const evaluated = evaluateJsonExpressionWithResult(expression, context, {
    ...host,
    onResourceValueObservation: observation => observations.push(observation)
  }, generatedPath);
  return evaluated ? { evaluated, observations } : undefined;
}

/** Publishes observations captured by a successful lowering operation. */
export function commitCapturedItemModelObservations(
  host: ItemModelExecutorHost,
  observations: readonly RsglResourceValueObservation[],
  generatedPath: string,
  scalarModel: boolean
): void {
  for (const observation of observations) {
    host.onResourceValueObservation?.(
      scalarModel && observation.generatedPath === generatedPath
        ? { ...observation, generatedPath: appendGeneratedPath(generatedPath, "model") }
        : observation
    );
  }
}

/** Builds both direct and validation-only provenance mappings for an expression. */
export function itemModelExpressionMappings(
  evaluated: EvaluatedJsonExpression,
  sourceRange: TextRange,
  context: EvaluationContext,
  generatedPath: string,
  scalarChild?: string
): ResourceBodyMapping[] {
  const sinkPath = scalarChild ? appendGeneratedPath(generatedPath, scalarChild) : generatedPath;
  return [
    { generatedPath: sinkPath, sourceRange, context },
    ...evaluatedPathOrigins(evaluated.result, sinkPath).map(origin => ({
      generatedPath: origin.generatedPath,
      sourceRange,
      context,
      validationOrigin: origin,
      validationOnly: true
    }))
  ];
}

export function itemModelNodeMapping(
  generatedPath: string,
  sourceRange: TextRange,
  context: EvaluationContext
): ResourceBodyMapping {
  return { generatedPath, sourceRange, context };
}

export function terminalItemModel(
  type: string,
  range: TextRange,
  context: RsglCompileContext,
  generatedPath: string
): LoweredItemModel {
  return {
    value: { type },
    mappings: [itemModelNodeMapping(generatedPath, range, context)]
  };
}
