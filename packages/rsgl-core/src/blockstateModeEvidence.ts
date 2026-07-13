import type { BlockstateMode, ExprNode, RsglNode } from "./parser";

export type StaticBlockstateModeEvidence = BlockstateMode | "neutral" | "conflict";

/** Returns statically named root fields without evaluating computed keys. */
export function staticBlockstateRootFields(expression: ExprNode): Map<string, RsglNode> {
  const fields = new Map<string, RsglNode>();
  if (expression.kind !== "ObjectExpr") {
    return fields;
  }
  for (const property of expression.properties) {
    if (property.key.kind === "Identifier") {
      fields.set(property.key.text, property.key);
    } else if (property.key.kind === "StringLiteral") {
      fields.set(property.key.value, property.key);
    }
  }
  return fields;
}

/** Infers only unambiguous, statically visible variants/multipart evidence. */
export function inferStaticBlockstateMode(expression: ExprNode): StaticBlockstateModeEvidence {
  const fields = staticBlockstateRootFields(expression);
  const hasVariants = fields.has("variants");
  const hasMultipart = fields.has("multipart");
  if (hasVariants && hasMultipart) {
    return "conflict";
  }
  return hasVariants ? "variants" : hasMultipart ? "multipart" : "neutral";
}
