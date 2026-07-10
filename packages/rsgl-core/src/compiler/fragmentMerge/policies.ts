import { appendGeneratedPath } from "../sourcePaths";
import type {
  FragmentMergeDecisionContext,
  FragmentMergePolicy
} from "./types";

export const genericFragmentMergePolicy: FragmentMergePolicy = {
  resourceKind: "generic",
  decide: () => ({ kind: "allow" })
};

export const blockstateFragmentMergePolicy: FragmentMergePolicy = {
  resourceKind: "blockstate",
  decide(context) {
    if (context.targetPath !== "") {
      return { kind: "allow" };
    }

    if (context.mode === "append") {
      if (context.key !== "multipart") {
        return reject(
          context,
          `merge append is not allowed for blockstate field '${appendGeneratedPath(context.targetPath, context.key)}'; only 'multipart' can be appended.`
        );
      }
      if (!Array.isArray(context.incoming)) {
        return reject(
          context,
          "merge append requires blockstate 'multipart' to be an array."
        );
      }
    }

    if (context.key === "variants" && context.target.multipart !== undefined) {
      return reject(context, "A blockstate body cannot merge 'variants' while 'multipart' is present.");
    }
    if (context.key === "multipart" && context.target.variants !== undefined) {
      return reject(context, "A blockstate body cannot merge 'multipart' while 'variants' is present.");
    }

    return { kind: "allow" };
  }
};

export function fragmentMergePolicyFor(resourceKind: string): FragmentMergePolicy {
  return resourceKind === "blockstate" ? blockstateFragmentMergePolicy : genericFragmentMergePolicy;
}

function reject(
  _context: FragmentMergeDecisionContext,
  message: string
): ReturnType<FragmentMergePolicy["decide"]> {
  return {
    kind: "reject",
    code: "rsgl.mergeOperationNotAllowed",
    message
  };
}
