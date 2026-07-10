export { FragmentMergeEngine, fragmentMergeEngine } from "./engine";
export { mappingTargetsAppliedContent, offsetFragmentMappingPath } from "./mapping";
export { valueMergeAction } from "./operations";
export {
  blockstateFragmentMergePolicy,
  fragmentMergePolicyFor,
  genericFragmentMergePolicy
} from "./policies";
export type {
  FragmentMergeDecision,
  FragmentMergeDecisionContext,
  FragmentMergeDiagnostic,
  FragmentMergeMode,
  FragmentMergePolicy,
  MergeFragment,
  MergeResult
} from "./types";
