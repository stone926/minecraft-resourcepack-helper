import type { ExprNode, PropertyKeyNode } from "../parser";
import { staticPropertyKeyName } from "../parser";
import { diagnostic } from "./diagnostics";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import type { RsglScope, RsglType } from "./types";
import { finiteObjectKeysFromType, staticIndexKey } from "./structuralTypes";

export interface RsglPropertyKeyCheckResult {
  /** Exact possible spellings when the key has a statically finite domain. */
  readonly names?: readonly string[];
  readonly type?: RsglType;
}

export interface RsglPropertyKeyCheckHost {
  checkExpression(
    context: RsglExpressionCheckContext,
    expression: ExprNode,
    scope: RsglScope
  ): RsglType;
}

/** Checks one shared object/resource property key without evaluating it. */
export function checkPropertyKey(
  context: RsglExpressionCheckContext,
  key: PropertyKeyNode,
  scope: RsglScope,
  host: RsglPropertyKeyCheckHost
): RsglPropertyKeyCheckResult {
  const staticName = staticPropertyKeyName(key);
  if (staticName !== undefined) {
    return { names: [staticName] };
  }
  if (key.kind !== "DynamicKey") {
    return {};
  }

  const type = host.checkExpression(context, key.expression, scope);
  if (!isPotentialPropertyKeyType(type)) {
    context.diagnostics.push(diagnostic(
      "rsgl.invalidPropertyKey",
      "A computed property key must evaluate to a string, number, or boolean scalar value.",
      key.expression.range
    ));
  }
  const literalName = staticIndexKey(key.expression);
  const finiteNames = literalName === undefined ? finiteObjectKeysFromType(type) : undefined;
  return {
    type,
    ...(literalName !== undefined
      ? { names: [literalName] }
      : finiteNames?.length
        ? { names: finiteNames }
        : {})
  };
}

function isPotentialPropertyKeyType(type: RsglType): boolean {
  if (type.kind === "Union") {
    return (type.options ?? []).every(isPotentialPropertyKeyType);
  }
  return type.kind === "String"
    || type.kind === "Number"
    || type.kind === "Boolean"
    || type.kind === "Path"
    || type.kind === "ResourceId"
    || type.kind === "ModelId"
    || type.kind === "TextureId"
    || type.kind === "Any"
    || type.kind === "Unknown"
    || type.kind === "TypeParameter"
    || type.kind === "Json";
}
