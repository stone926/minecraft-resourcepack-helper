import type { ExprNode, LambdaExprNode } from "../parser";
import { diagnostic } from "./diagnostics";
import {
  findLambdaImpureCalls,
  lambdaImpureCallMessage,
  resolvedBuiltinEffect
} from "./lambdaPurity";
import { createChildScope, lookup } from "./scopes";
import { formatType, isAssignable } from "./typeRelations";
import {
  anyType,
  type RsglScope,
  type RsglSignature,
  type RsglType
} from "./types";
import type { RsglExpressionCheckContext } from "./expressionChecker";

export type LambdaBodyChecker = (
  expression: ExprNode,
  scope: RsglScope,
  expectedType?: RsglType
) => RsglType;

export interface LambdaCheckOptions {
  returnMismatchCode?: string;
  returnMismatchMessage?: (expected: RsglType, actual: RsglType) => string;
  /** Keep the checked body type so builtin generic inference can inspect it. */
  preserveActualReturnType?: boolean;
}

/**
 * Checks a lambda with an optional contextual Function type. The returned
 * Function deliberately adopts the contextual shape after emitting dedicated
 * diagnostics so the enclosing let/argument check does not duplicate them as
 * a generic type mismatch.
 */
export function checkLambdaExpression(
  context: RsglExpressionCheckContext,
  expression: LambdaExprNode,
  scope: RsglScope,
  expectedType: RsglType | undefined,
  checkBody: LambdaBodyChecker,
  options: LambdaCheckOptions = {}
): RsglType {
  const contextualFunction = expectedType?.kind === "Function" ? expectedType : undefined;
  const declaredParameters = contextualFunction?.parameters;
  const contextualArityMatches = !declaredParameters
    || declaredParameters.length === expression.parameters.length;
  if (declaredParameters && !contextualArityMatches) {
    context.diagnostics.push(diagnostic(
      "rsgl.lambdaArityMismatch",
      `Expected ${declaredParameters.length} lambda parameter(s), got ${expression.parameters.length}.`,
      expression.range
    ));
  }
  // An invalid arity has no sound positional mapping. Keep checking the body
  // for intrinsic errors and purity, but do not manufacture parameter/return
  // cascades from a contextual signature that cannot apply to this lambda.
  const contextualParameters = contextualArityMatches ? declaredParameters : undefined;

  const lambdaScope = createChildScope(scope, "lambda");
  const seen = new Set<string>();
  for (const [index, parameter] of expression.parameters.entries()) {
    if (seen.has(parameter.text)) {
      context.diagnostics.push(diagnostic(
        "rsgl.duplicateLambdaParameter",
        `Duplicate lambda parameter '${parameter.text}'.`,
        parameter.range
      ));
      continue;
    }
    seen.add(parameter.text);
    context.defineIdentifier(
      lambdaScope,
      parameter,
      "parameter",
      contextualParameters?.[index] ?? anyType,
      parameter
    );
  }

  const expectedReturnType = contextualArityMatches ? contextualFunction?.returnType : undefined;
  const bodyDiagnosticStart = context.diagnostics.length;
  const actualReturnType = checkBody(expression.body, lambdaScope, expectedReturnType);
  if (
    expectedReturnType
    && !isAssignable(expectedReturnType, actualReturnType)
    && context.diagnostics.length === bodyDiagnosticStart
  ) {
    context.diagnostics.push(diagnostic(
      options.returnMismatchCode ?? "rsgl.lambdaReturnTypeMismatch",
      options.returnMismatchMessage?.(expectedReturnType, actualReturnType)
        ?? `Expected lambda return ${formatType(expectedReturnType)}, got ${formatType(actualReturnType)}.`,
      expression.body.range
    ));
  }
  for (const impureCall of findLambdaImpureCalls(
    expression.body,
    name => resolvedBuiltinEffect(lookup(lambdaScope, name))
  )) {
    context.diagnostics.push(diagnostic(
      "rsgl.lambdaImpureCall",
      lambdaImpureCallMessage(impureCall.name),
      impureCall.range
    ));
  }

  if (contextualFunction) {
    if (!contextualArityMatches && !options.preserveActualReturnType) {
      return contextualFunction;
    }
    return {
      ...contextualFunction,
      parameters: contextualParameters ?? expression.parameters.map(() => anyType),
      returnType: options.preserveActualReturnType
        ? actualReturnType
        : contextualFunction.returnType ?? actualReturnType
    };
  }
  return {
    kind: "Function",
    parameters: expression.parameters.map(() => anyType),
    returnType: actualReturnType
  };
}

/** Builds the stable named signature attached to a let-bound lambda symbol. */
export function lambdaSignature(
  expression: LambdaExprNode,
  type: RsglType
): RsglSignature | undefined {
  const parameterTypes = type.kind === "Function" ? type.parameters ?? [] : [];
  if (type.kind === "Function" && type.parameters?.length !== expression.parameters.length) {
    // A named signature is a public parameter-name/type contract. An invalid
    // annotation-to-lambda mapping cannot safely provide that contract to
    // local named calls, imports, or re-exports.
    return undefined;
  }
  const parameterCount = parameterTypes.length || expression.parameters.length;
  return {
    valueFunction: true,
    parameters: Array.from({ length: parameterCount }, (_, index) => ({
      name: expression.parameters[index]?.text ?? `arg${index + 1}`,
      type: parameterTypes[index] ?? anyType,
      optional: false,
      node: expression.parameters[index]
    })),
    returnType: type.kind === "Function" ? type.returnType ?? anyType : anyType
  };
}
