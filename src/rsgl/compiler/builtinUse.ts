import {
  ArgumentNode,
  CallExprNode,
  ExprNode,
  IdentifierExprNode,
  TextRange
} from "../parser";
import { EvaluationContext, evaluateExpression } from "./evaluate";
import { ExpansionFrame, ResourceUnit } from "./ir";
import {
  createCubeAllModel,
  createGeneratedItemModel,
  createItemMapping
} from "./templates";

export interface RsglBuiltinUseOptions {
  sourceFile: string;
  expansionStack: ExpansionFrame[];
  onError?: (code: string, message: string, range: TextRange) => void;
}

export function compileBuiltinUse(
  expression: ExprNode,
  context: EvaluationContext,
  options: RsglBuiltinUseOptions
): ResourceUnit[] | null {
  const call = builtinUseCall(expression);
  if (!call) {
    return null;
  }

  if (call.callee.name.text === "cubeAll") {
    const id = requiredTextArg(call, "id", 0, context, options);
    if (!id) {
      return [];
    }
    const texture = optionalTextArg(call, "texture", 1, context, options);
    return compact([
      createCubeAllModel(id, texture ?? undefined, context.namespace, options.sourceFile, call.range, options.expansionStack)
    ]);
  }

  if (call.callee.name.text === "itemGenerated") {
    const id = requiredTextArg(call, "id", 0, context, options);
    if (!id) {
      return [];
    }
    const texture = optionalTextArg(call, "texture", 1, context, options);
    return compact([
      createGeneratedItemModel(id, texture ?? undefined, context.namespace, options.sourceFile, call.range, options.expansionStack),
      createItemMapping(id, undefined, context.namespace, options.sourceFile, call.range, options.expansionStack)
    ]);
  }

  return null;
}

function builtinUseCall(expression: ExprNode): (CallExprNode & { callee: IdentifierExprNode }) | null {
  return expression.kind === "CallExpr" && expression.callee.kind === "IdentifierExpr"
    ? expression as CallExprNode & { callee: IdentifierExprNode }
    : null;
}

function requiredTextArg(
  call: CallExprNode,
  name: string,
  positionalIndex: number,
  context: EvaluationContext,
  options: RsglBuiltinUseOptions
): string | null {
  const arg = findArg(call, name, positionalIndex);
  if (!arg) {
    options.onError?.("rsgl.compileMissingArgument", `Missing builtin use argument '${name}'.`, call.range);
    return null;
  }
  return staticText(arg, context, options, name);
}

function optionalTextArg(
  call: CallExprNode,
  name: string,
  positionalIndex: number,
  context: EvaluationContext,
  options: RsglBuiltinUseOptions
): string | null {
  const arg = findArg(call, name, positionalIndex);
  return arg ? staticText(arg, context, options, name) : null;
}

function staticText(
  arg: ArgumentNode,
  context: EvaluationContext,
  options: RsglBuiltinUseOptions,
  name: string
): string | null {
  const value = evaluateExpression(arg.value, context);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  options.onError?.("rsgl.invalidBuiltinUseArgument", `Builtin use argument '${name}' must evaluate to a resource id string.`, arg.value.range);
  return null;
}

function findArg(call: CallExprNode, name: string, positionalIndex: number): ArgumentNode | undefined {
  return call.args.find(arg => arg.name?.text === name)
    ?? call.args.filter(arg => !arg.name)[positionalIndex];
}

function compact<T>(values: Array<T | null>): T[] {
  return values.filter((value): value is T => value !== null);
}
