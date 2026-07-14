import type { BlockstateMode, ExprNode, RsglNode } from "./parser";

export type StaticBlockstateModeEvidence = BlockstateMode | "neutral" | "conflict";

/** Returns statically named root fields without evaluating computed keys. */
export function staticBlockstateRootFields(expression: ExprNode): Map<string, RsglNode> {
  const fields = new Map<string, RsglNode>();
  if (expression.kind !== "ObjectExpr") {
    return fields;
  }
  for (const entry of expression.properties) {
    if (entry.kind === "ObjectSpread") {
      continue;
    }
    if (entry.key.kind === "Identifier") {
      fields.set(entry.key.text, entry.key);
    } else if (entry.key.kind === "StringLiteral") {
      fields.set(entry.key.value, entry.key);
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
