import { tryParseMinecraftResourceId } from "../../../mc-assets/src";
import { bindRsglArgumentSlots } from "../arguments";
import type { ExprNode, TextRange } from "../parser";
import { getBuiltinSignature } from "../semantic/builtins";
import {
  type CollectionLambdaArgument,
  evaluateCollectionBuiltin
} from "./collectionBuiltins";
import { contextualizeEvaluatedValue } from "./contextualResourceValueConversion";
import { evaluationItemBudget } from "./evaluationBudget";
import { reportContextualValueError } from "./evaluationErrors";
import { MAX_EVALUATION_ITEMS_PER_ALLOCATION } from "./evaluationItemBudget";
import { consumeEvaluationItems } from "./evaluationItemAccounting";
import type { EvaluationCallArgument, EvaluationRuntimeHost } from "./evaluationRuntimeHost";
import type {
  EvaluationContext,
  EvaluationValue,
  LambdaValue
} from "./evaluationTypes";
import {
  evaluationScalarText,
  isEvaluatedResourceId,
  isEvaluatedResourceValue
} from "./evaluatedResourceValues";
import { rangeForEvaluationPath } from "./evaluationProvenance";
import { selectEvaluationResultPath } from "./evaluationTrace";
import { evaluateLambdaCall, isLambdaValue } from "./lambdaEvaluation";
import {
  isRsglResourceIdConstructorName,
  rsglResourceIdConstructors,
  typeKindForResourceValueKind
} from "../resourceIdSemantics";
import { expandSequencePatternWithinBudget } from "./sequenceEvaluation";

const horizontalYaw: Record<string, number> = {
  north: 0,
  east: 90,
  south: 180,
  west: 270
};

export function evaluateCallExpression(
  callee: ExprNode,
  args: EvaluationCallArgument[],
  context: EvaluationContext,
  range: TextRange,
  host: EvaluationRuntimeHost
): EvaluationValue {
  if (callee.kind !== "IdentifierExpr") {
    context.onEvaluationFailure?.();
    return undefined;
  }

  const signature = getBuiltinSignature(callee.name.text);
  if (signature) {
    const binding = bindRsglArgumentSlots(
      signature.parameters,
      args,
      arg => arg.name
    );
    if (binding.issues.length > 0) {
      // Semantic checking emits the actionable binder diagnostic. Runtime uses
      // the same slot result as a strict gate so malformed calls never execute.
      context.onEvaluationFailure?.();
      return undefined;
    }
    args = binding.assignments.map(assignment => assignment.arg);
  }

  if (isRsglResourceIdConstructorName(callee.name.text)) {
    return evaluateResourceIdConstructor(callee.name.text, args, context);
  }

  const collection = evaluateCollectionBuiltin(
    callee.name.text,
    args,
    range,
    collectionBuiltinHost(context, host)
  );
  if (collection.handled) {
    if (collection.trace) {
      context.evaluationTrace?.recordCollectionTrace(collection.trace);
    }
    return collection.value;
  }

  if (callee.name.text === "glob") {
    const pattern = argumentValue(args, "pattern", 0);
    const budget = evaluationItemBudget(context);
    const globLimit = Math.min(budget.remaining, MAX_EVALUATION_ITEMS_PER_ALLOCATION);
    const loaded = typeof pattern === "string"
      ? context.globLoader?.(pattern, context, range, {
        maxMatches: globLimit,
        maxVisitedEntries: globLimit
      })
      : undefined;
    if (loaded && !Array.isArray(loaded)) {
      consumeEvaluationItems(context, globLimit + 1, range, "glob");
      return undefined;
    }
    const matches = loaded ?? [];
    return consumeEvaluationItems(context, matches.length, range, "glob")
      ? matches
      : undefined;
  }
  if (callee.name.text === "pad") {
    const value = scalarText(argumentValue(args, "value", 0)) ?? "";
    const width = Number(argumentValue(args, "width", 1) ?? 0);
    return value.padStart(width, "0");
  }
  if (callee.name.text === "seq") {
    const pattern = scalarText(argumentValue(args, "pattern", 0)) ?? "";
    return expandSequencePatternWithinBudget(pattern, null, context, range);
  }
  if (callee.name.text === "yaw") {
    return horizontalYaw[scalarText(argumentValue(args, "direction", 0)) ?? ""] ?? 0;
  }
  if (callee.name.text === "model_path") {
    return resourceAssetPath(argumentValue(args, "id", 0), context.namespace, "models", "json");
  }
  if (callee.name.text === "texture_path") {
    return resourceAssetPath(argumentValue(args, "id", 0), context.namespace, "textures", "png");
  }
  if (callee.name.text === "resource_namespace") {
    return parseResourceIdValue(argumentValue(args, "id", 0), context.namespace)?.namespace ?? "";
  }
  if (callee.name.text === "resource_path") {
    return parseResourceIdValue(argumentValue(args, "id", 0), context.namespace)?.path ?? "";
  }
  if (callee.name.text === "startsWith") {
    return (scalarText(argumentValue(args, "str", 0)) ?? "")
      .startsWith(scalarText(argumentValue(args, "prefix", 1)) ?? "");
  }
  if (callee.name.text === "endsWith") {
    return (scalarText(argumentValue(args, "str", 0)) ?? "")
      .endsWith(scalarText(argumentValue(args, "suffix", 1)) ?? "");
  }
  if (callee.name.text === "has") {
    const object = argumentValue(args, "object", 0);
    const key = argumentValue(args, "key", 1);
    return typeof key === "string" && hasOwnEvaluationProperty(object, key);
  }
  if (callee.name.text === "replace") {
    const source = scalarText(argumentValue(args, "str", 0)) ?? "";
    const oldText = scalarText(argumentValue(args, "old", 1)) ?? "";
    const newText = scalarText(argumentValue(args, "new", 2)) ?? "";
    return oldText ? source.split(oldText).join(newText) : source;
  }
  if (callee.name.text === "padStart") {
    const source = scalarText(argumentValue(args, "str", 0)) ?? "";
    const length = Number(argumentValue(args, "len", 1) ?? 0);
    const pad = scalarText(argumentValue(args, "pad", 2)) ?? "";
    return source.padStart(length, pad);
  }
  if (callee.name.text === "padEnd") {
    const source = scalarText(argumentValue(args, "str", 0)) ?? "";
    const length = Number(argumentValue(args, "len", 1) ?? 0);
    const pad = scalarText(argumentValue(args, "pad", 2)) ?? "";
    return source.padEnd(length, pad);
  }

  context.onEvaluationFailure?.();
  return undefined;
}

function collectionBuiltinHost(context: EvaluationContext, host: EvaluationRuntimeHost) {
  return {
    budget: evaluationItemBudget(context),
    isLambda: isLambdaValue,
    invokeLambda: (lambda: LambdaValue, argument: CollectionLambdaArgument) => {
      const result = argument.result && argument.selectedPath !== undefined
        ? selectEvaluationResultPath(argument.result, argument.selectedPath)
        : argument.result;
      const argumentRange = result
        ? rangeForEvaluationPath(result.pathRanges, "") ?? argument.range
        : argument.range;
      const value = evaluateLambdaCall(lambda, 1, [{
        value: argument.value,
        range: argumentRange,
        ...(result ? { result } : {}),
        sourceFile: argument.sourceFile
      }], context, host);
      return {
        value,
        result: context.evaluationTrace?.latestChildResult(lambda.body),
        sourceFile: lambda.context.sourceFile
      };
    },
    reportError: (code: string, message: string, range: TextRange) => {
      context.onError?.(code, message, range, context.sourceFile);
    },
    markFailure: () => context.onEvaluationFailure?.()
  };
}

function evaluateResourceIdConstructor(
  constructorName: keyof typeof rsglResourceIdConstructors,
  args: EvaluationCallArgument[],
  context: EvaluationContext
): EvaluationValue {
  if (args.length !== 1) {
    // Semantic argument binding owns the arity/name diagnostic. Runtime still
    // gates the call so a malformed constructor cannot materialize a value.
    context.onEvaluationFailure?.();
    return undefined;
  }
  const argument = args[0];
  if (argument.value === undefined) {
    // The argument evaluation already owns the actionable diagnostic. Do not
    // reinterpret its failure as a second resource-reference shape error at
    // the enclosing constructor boundary.
    context.onEvaluationFailure?.();
    return undefined;
  }
  const expectedKind = rsglResourceIdConstructors[constructorName];
  const argumentText = evaluationScalarText(argument.value);
  if (constructorName === "texture_id" && argumentText?.startsWith("#")) {
    reportContextualValueError(
      {
        code: "rsgl.invalidConstructedResourceId",
        message: `texture_id cannot construct a TextureId from texture variable '${argumentText}'.`
      },
      argument.range,
      context
    );
    return undefined;
  }
  const converted = contextualizeEvaluatedValue(
    argument.value,
    { kind: typeKindForResourceValueKind(expectedKind) },
    context.namespace
  );
  if (!converted.ok) {
    reportContextualValueError(converted.error, argument.range, context);
    return undefined;
  }
  return converted.value as EvaluationValue;
}

function argumentValue(
  args: Array<{ name?: string; value: EvaluationValue }>,
  name: string,
  positionalIndex: number
): EvaluationValue {
  return args.find(arg => arg.name === name)?.value
    ?? args.filter(arg => !arg.name)[positionalIndex]?.value;
}

function resourceAssetPath(
  value: EvaluationValue,
  namespace: string,
  root: string,
  extension: string
): string {
  const id = parseResourceIdValue(value, namespace);
  if (!id) {
    return "";
  }
  return `assets/${id.namespace}/${root}/${id.path}.${extension}`;
}

function parseResourceIdValue(
  value: EvaluationValue,
  namespace: string
): { namespace: string; path: string } | null {
  if (isEvaluatedResourceId(value)) {
    return { namespace: value.namespace, path: value.path };
  }
  const text = scalarText(value);
  return text && !text.startsWith("#") ? tryParseMinecraftResourceId(text, namespace) : null;
}

function hasOwnEvaluationProperty(value: EvaluationValue, key: string): boolean {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && !isEvaluatedResourceValue(value)
    && !isLambdaValue(value)
    && Object.hasOwn(value, key)
  );
}

function scalarText(value: EvaluationValue): string | null {
  return evaluationScalarText(value);
}
