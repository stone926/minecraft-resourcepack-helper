import type { JsonValue } from "../ir";
import { cloneJsonValue } from "../jsonValues";
import { appendGeneratedPath } from "../sourcePaths";
import { valueMergeAction } from "./operations";
import type {
  FragmentMergeDiagnostic,
  FragmentMergeMode,
  FragmentMergePolicy,
  MergeFragment,
  MergeResult
} from "./types";

export class FragmentMergeEngine {
  public apply(
    target: Record<string, JsonValue>,
    fragment: MergeFragment,
    policy: FragmentMergePolicy,
    targetPath = ""
  ): MergeResult {
    const diagnostics: FragmentMergeDiagnostic[] = [];
    const arrayOffsets = new Map<string, number>();
    const applied = this.applyObject(
      target,
      fragment.content,
      fragment.mode,
      policy,
      targetPath,
      fragment.sourceRange,
      diagnostics,
      arrayOffsets
    );
    return { applied, diagnostics, arrayOffsets };
  }

  private applyObject(
    target: Record<string, JsonValue>,
    source: Record<string, JsonValue>,
    mode: FragmentMergeMode,
    policy: FragmentMergePolicy,
    targetPath: string,
    sourceRange: MergeFragment["sourceRange"],
    diagnostics: FragmentMergeDiagnostic[],
    arrayOffsets: Map<string, number>
  ): Record<string, JsonValue> {
    const applied: Record<string, JsonValue> = {};
    for (const [key, incoming] of Object.entries(source)) {
      const existing = target[key];
      const keyPath = appendGeneratedPath(targetPath, key);
      const decision = policy.decide({
        mode,
        targetPath,
        key,
        target,
        existing,
        incoming,
        sourceRange
      });
      if (decision.kind === "reject") {
        diagnostics.push({
          code: decision.code ?? "rsgl.mergeOperationNotAllowed",
          message: decision.message ?? `Merge mode '${mode}' is not allowed for field '${keyPath}'.`,
          range: sourceRange
        });
        continue;
      }

      if (mode === "shallow") {
        target[key] = cloneJsonValue(incoming);
        applied[key] = incoming;
        continue;
      }

      const action = valueMergeAction(mode, existing, incoming);
      if (action.kind === "assign") {
        target[key] = action.value;
        applied[key] = incoming;
      } else if (action.kind === "concatenate") {
        target[key] = action.value;
        applied[key] = incoming;
        arrayOffsets.set(keyPath, action.offset);
      } else if (action.kind === "recurse") {
        const nested = this.applyObject(
          action.target,
          action.incoming,
          mode,
          policy,
          keyPath,
          sourceRange,
          diagnostics,
          arrayOffsets
        );
        if (Object.keys(nested).length > 0 || (action.created && Object.keys(action.incoming).length === 0)) {
          target[key] = action.target;
          applied[key] = Object.keys(nested).length > 0 ? nested : {};
        }
      } else if (mode === "strict") {
        diagnostics.push({
          code: "rsgl.mergeFieldNotFound",
          message: `merge strict cannot update missing field '${keyPath}'.`,
          range: sourceRange
        });
      } else {
        diagnostics.push({
          code: "rsgl.mergeAppendIncompatibleField",
          message: `merge append cannot combine field '${keyPath}' because the existing and incoming values are not compatible arrays or objects.`,
          range: sourceRange
        });
      }
    }
    return applied;
  }
}

export const fragmentMergeEngine = new FragmentMergeEngine();
