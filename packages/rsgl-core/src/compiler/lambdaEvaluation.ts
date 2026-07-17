import { bindEvaluationResult } from "./evaluationBindings";
import { reportContextualValueError } from "./evaluationErrors";
import { isLambdaLikeValue } from "./evaluationJsonValues";
import type { EvaluationCallArgument, EvaluationRuntimeHost } from "./evaluationRuntimeHost";
import type {
  EvaluationContext,
  EvaluationValue,
  LambdaValue
} from "./evaluationTypes";
import { contextualizeEvaluatedValue } from "./contextualResourceValueConversion";

export function evaluateLambdaCall(
  lambda: LambdaValue,
  argCount: number,
  args: EvaluationCallArgument[],
  callContext: EvaluationContext,
  host: EvaluationRuntimeHost
): EvaluationValue {
  if (lambda.impureCalls.length > 0) {
    // Enforcement only: the semantic layer reports rsgl.lambdaImpureCall at the
    // lambda's definition site, so the gate refuses execution without adding a
    // duplicate diagnostic.
    callContext.onEvaluationFailure?.();
    return undefined;
  }
  if (argCount !== lambda.parameters.length) {
    // Semantic checking owns the single diagnostic, including calls through
    // imported/re-exported signatures. Runtime remains a strict gate so an
    // invalid call cannot materialize output with partially bound values.
    callContext.onEvaluationFailure?.();
    return undefined;
  }
  const onError = callContext.onError ?? lambda.context.onError;

  const positional = args.filter(arg => !arg.name);
  const values: Record<string, EvaluationValue> = {};
  const bindings = new Map<string, EvaluationCallArgument | undefined>();
  lambda.parameters.forEach((parameter, index) => {
    const arg = args.find(item => item.name === parameter) ?? positional[index];
    const expectedType = lambda.signature?.parameters[index];
    if (!arg || !expectedType || arg.value === undefined) {
      values[parameter] = arg?.value;
    } else {
      const converted = contextualizeEvaluatedValue(
        arg.value,
        expectedType,
        callContext.namespace
      );
      if (!converted.ok) {
        reportContextualValueError(converted.error, arg.range, callContext);
        values[parameter] = undefined;
      } else {
        values[parameter] = converted.value as EvaluationValue;
      }
    }
    bindings.set(parameter, arg);
  });
  if (lambda.parameters.some(parameter => values[parameter] === undefined)) {
    return undefined;
  }

  const bodyContext = host.childEvaluationContext(lambda.context, values, { onError });
  bodyContext.evaluationItemBudget = callContext.evaluationItemBudget
    ?? lambda.context.evaluationItemBudget;
  bodyContext.evaluationTrace = callContext.evaluationTrace;
  bodyContext.onEvaluationFailure = callContext.onEvaluationFailure
    ?? lambda.context.onEvaluationFailure;
  bodyContext.onResourceValueFailure = callContext.onResourceValueFailure
    ?? lambda.context.onResourceValueFailure;
  for (const [parameter, arg] of bindings) {
    if (arg?.result) {
      bindEvaluationResult(
        bodyContext,
        parameter,
        { ...arg.result, value: values[parameter] },
        callContext.sourceFile
      );
    }
  }
  // Defense in depth: even if the purity scan misses a pattern, the body
  // cannot reach filesystem loaders.
  bodyContext.baseDocumentLoader = undefined;
  bodyContext.onDependency = undefined;
  bodyContext.globLoader = undefined;
  const value = host.evaluateExpression(lambda.body, bodyContext);
  const returnType = lambda.signature?.returnType;
  if (!returnType || value === undefined) {
    return value;
  }
  const converted = contextualizeEvaluatedValue(
    value,
    returnType,
    lambda.context.namespace
  );
  if (!converted.ok) {
    reportContextualValueError(
      converted.error,
      lambda.body.range,
      bodyContext,
      lambda.context.sourceFile
    );
    return undefined;
  }
  return converted.value as EvaluationValue;
}

export function isLambdaValue(value: EvaluationValue): value is LambdaValue {
  return isLambdaLikeValue(value);
}

export function captureEvaluationContext(context: EvaluationContext): EvaluationContext {
  const captured = { ...context };
  delete captured.evaluationTrace;
  return {
    ...captured,
    variables: new Map(context.variables),
    valueOrigins: context.valueOrigins ? new Map(context.valueOrigins) : undefined,
    valuePathOrigins: context.valuePathOrigins ? new Map(context.valuePathOrigins) : undefined,
    valueIssues: context.valueIssues ? new Map(context.valueIssues) : undefined
  };
}
