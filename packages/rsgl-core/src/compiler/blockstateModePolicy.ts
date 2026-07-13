import type { JsonValue } from "./ir";

export type BlockstateMode = "variants" | "multipart";

export type BlockstateRootModeEvidence = "none" | BlockstateMode | "both";

export interface BlockstateModeConflict {
  code: "rsgl.blockstateModeConflict";
  message: string;
  declaredMode: BlockstateMode;
  evidence: Exclude<BlockstateRootModeEvidence, "none">;
}

export type BlockstateModePreflightResult =
  | { compatible: true; evidence: BlockstateRootModeEvidence }
  | { compatible: false; evidence: Exclude<BlockstateRootModeEvidence, "none">; diagnostic: BlockstateModeConflict };

/** Returns only static top-level mode evidence from a complete blockstate root object. */
export function blockstateRootModeEvidence(
  operand: Readonly<Record<string, JsonValue>>
): BlockstateRootModeEvidence {
  const hasVariants = Object.prototype.hasOwnProperty.call(operand, "variants");
  const hasMultipart = Object.prototype.hasOwnProperty.call(operand, "multipart");
  if (hasVariants && hasMultipart) {
    return "both";
  }
  if (hasVariants) {
    return "variants";
  }
  return hasMultipart ? "multipart" : "none";
}

/**
 * Checks a complete root operand against the mode fixed by its declaration.
 * Callers must run this before mutating content so a conflicting operand is
 * rejected atomically, including otherwise-compatible custom fields.
 */
export function preflightBlockstateRootOperand(
  declaredMode: BlockstateMode,
  operand: Readonly<Record<string, JsonValue>>
): BlockstateModePreflightResult {
  const evidence = blockstateRootModeEvidence(operand);
  if (evidence === "none" || evidence === declaredMode) {
    return { compatible: true, evidence };
  }

  const message = evidence === "both"
    ? `A '${declaredMode}' blockstate root operand cannot contain both 'variants' and 'multipart'.`
    : `A '${declaredMode}' blockstate root operand cannot contain the opposite '${evidence}' mode.`;
  return {
    compatible: false,
    evidence,
    diagnostic: {
      code: "rsgl.blockstateModeConflict",
      message,
      declaredMode,
      evidence
    }
  };
}
