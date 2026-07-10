import type { TextRange } from "../../parser";
import type { JsonValue } from "../ir";

/** The five user-visible fragment merge modes, normalized for the compiler. */
export type FragmentMergeMode = "shallow" | "deep" | "strict" | "upsert" | "append";

export interface MergeFragment {
  content: Record<string, JsonValue>;
  mode: FragmentMergeMode;
  sourceRange: TextRange;
}

export interface FragmentMergeDiagnostic {
  code:
    | "rsgl.mergeFieldNotFound"
    | "rsgl.mergeAppendIncompatibleField"
    | "rsgl.mergeOperationNotAllowed";
  message: string;
  range: TextRange;
}

export interface FragmentMergeDecisionContext {
  mode: FragmentMergeMode;
  /** JSON pointer of the object containing `key`. */
  targetPath: string;
  key: string;
  target: Record<string, JsonValue>;
  existing: JsonValue | undefined;
  incoming: JsonValue;
  sourceRange: TextRange;
}

export type FragmentMergeDecision =
  | { kind: "allow" }
  | {
    kind: "reject";
    code?: "rsgl.mergeOperationNotAllowed";
    message?: string;
  };

/** Resource-kind-specific restrictions layered over the shared merge modes. */
export interface FragmentMergePolicy {
  resourceKind: string;
  decide(context: FragmentMergeDecisionContext): FragmentMergeDecision;
}

export interface MergeResult {
  /** The subset of the incoming fragment that was actually applied. */
  applied: Record<string, JsonValue>;
  diagnostics: FragmentMergeDiagnostic[];
  /** Existing array length at every JSON pointer where an incoming array was concatenated. */
  arrayOffsets: Map<string, number>;
}
