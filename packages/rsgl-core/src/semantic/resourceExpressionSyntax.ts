import { parseMinecraftResourceId } from "../../../mc-assets/src";
import type { ExprNode, TextRange } from "../parser";
import { diagnostic } from "./diagnostics";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";

type ResourceSyntaxContext = Pick<RsglExpressionCheckContext, "diagnostics">;

export function validateResourceLocationLike(
  context: ResourceSyntaxContext,
  expression: ExprNode
): void {
  if (expression.kind === "ResourceLocationExpr") {
    validateResourceLocationValue(context, expression.value, expression.range);
  }
}

export function validateContextualResourceLiteral(
  context: ResourceSyntaxContext,
  expression: Extract<ExprNode, { kind: "StringLiteral" }>
): void {
  if (expression.value.startsWith("#")) {
    context.diagnostics.push(diagnostic(
      "rsgl.textureVariableInvalidContext",
      `Texture variable '${expression.value}' is only valid where TextureRef is expected.`,
      expression.range
    ));
    return;
  }
  validateResourceLocationValue(context, expression.value, expression.range);
}

/** Runs only the syntax checks that depend on a value being used as TextureRef. */
export function validateTextureRefExpressionSyntax(
  context: ResourceSyntaxContext,
  expression: ExprNode
): void {
  if (expression.kind !== "StringLiteral") {
    return;
  }
  if (expression.value.startsWith("#")) {
    if (!/^#[A-Za-z0-9_.\-/]+$/.test(expression.value)) {
      context.diagnostics.push(diagnostic(
        "rsgl.invalidTextureVariable",
        `Invalid texture variable '${expression.value}'.`,
        expression.range
      ));
    }
    return;
  }
  validateResourceLocationValue(context, expression.value, expression.range);
}

export function validateResourceLocationValue(
  context: ResourceSyntaxContext,
  value: string,
  range: TextRange
): void {
  const parsed = parseMinecraftResourceId(value);
  if (value.includes(":") && !parsed.isValid) {
    context.diagnostics.push(diagnostic(
      "rsgl.invalidResourceLocation",
      `Invalid resource location '${value}'.`,
      range
    ));
  } else if (!parsed.isValid) {
    context.diagnostics.push(diagnostic(
      "rsgl.invalidResourcePath",
      `Invalid resource path '${value}'.`,
      range
    ));
  }
}
