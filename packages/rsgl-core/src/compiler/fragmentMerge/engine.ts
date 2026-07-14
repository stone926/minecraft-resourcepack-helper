import type { JsonValue } from "../ir";
import {
  createJsonObject,
  jsonObjectEntries,
  jsonObjectKeys,
  setJsonObjectProperty
} from "../jsonObjectProperties";
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
    const applied = createJsonObject();
    for (const [key, incoming] of jsonObjectEntries(source)) {
      const existing = Object.hasOwn(target, key) ? target[key] : undefined;
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
        setJsonObjectProperty(target, key, cloneJsonValue(incoming));
        setJsonObjectProperty(applied, key, incoming);
        continue;
      }

      const action = valueMergeAction(mode, existing, incoming);
      if (action.kind === "assign") {
        setJsonObjectProperty(target, key, action.value);
        setJsonObjectProperty(applied, key, incoming);
      } else if (action.kind === "concatenate") {
        setJsonObjectProperty(target, key, action.value);
        setJsonObjectProperty(applied, key, incoming);
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
        if (jsonObjectKeys(nested).length > 0 || (action.created && jsonObjectKeys(action.incoming).length === 0)) {
          setJsonObjectProperty(target, key, action.target);
          setJsonObjectProperty(
            applied,
            key,
            jsonObjectKeys(nested).length > 0 ? nested : createJsonObject()
          );
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
