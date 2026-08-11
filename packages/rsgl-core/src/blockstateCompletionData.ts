import {
  blockstateModelOptions,
  type RsglBlockstateModelOptionName
} from "./blockstateModelOptions";
import type { RsglCompletionCandidate } from "./completionData";
import type { BlockstateMode } from "./parser";

const variantsEntryCompletions = [
  {
    label: "variant entry",
    insertText: "case { ${1:facing}: ${2:north} } => ${3:minecraft:block/stone}${4: with { y: 90 \\}}",
    detail: "Blockstate variant entry",
    kind: "snippet"
  },
  {
    label: "default variant",
    insertText: "case * => ${1:minecraft:block/stone}",
    detail: "Empty blockstate variant selector",
    kind: "snippet"
  },
  {
    label: "random",
    insertText: "case { ${1:facing}: ${2:north} } => random {\n  option ${3:minecraft:block/stone} weight ${4:2}\n  option ${5:minecraft:block/stone_alt}\n}",
    detail: "Random blockstate variant entry",
    kind: "snippet"
  }
] as const satisfies readonly RsglCompletionCandidate[];

const multipartEntryCompletions = [
  {
    label: "part when",
    insertText: "part when { ${1:facing}: ${2:north} } => ${3:minecraft:block/stone}${4: with { y: 90 \\}}",
    detail: "Multipart equality-record entry",
    kind: "snippet"
  },
  {
    label: "part when predicate",
    insertText: "part when \\$state.${1:facing} == ${2:north} => ${3:minecraft:block/stone}${4: with { y: 90 \\}}",
    detail: "Multipart StatePredicate entry",
    kind: "snippet"
  },
  {
    label: "part always",
    insertText: "part always => ${1:minecraft:block/stone}${2: with { y: 90 \\}}",
    detail: "Unconditional multipart entry",
    kind: "snippet"
  },
  {
    label: "random",
    insertText: "part always => random {\n  option ${1:minecraft:block/stone} weight ${2:2}\n  option ${3:minecraft:block/stone_alt}\n}",
    detail: "Random multipart entry",
    kind: "snippet"
  }
] as const satisfies readonly RsglCompletionCandidate[];

export const blockstateChoiceCompletions = [
  {
    label: "option",
    insertText: "option ${1:minecraft:block/stone}",
    detail: "Random blockstate model option",
    kind: "snippet"
  },
  {
    label: "weighted option",
    insertText: "option ${1:minecraft:block/stone}${2: with { y: 90 \\}} weight ${3:2}",
    detail: "Weighted random blockstate model option",
    kind: "snippet"
  }
] as const satisfies readonly RsglCompletionCandidate[];

const blockstateModelOptionDetails: Record<RsglBlockstateModelOptionName, string> = {
  x: "Blockstate model x rotation",
  y: "Blockstate model y rotation",
  z: "Blockstate model z rotation",
  uvlock: "Lock blockstate model UVs after rotation"
};

export const blockstateModelOptionCompletions: readonly RsglCompletionCandidate[] =
  blockstateModelOptions.map(option => ({
    label: option.name,
    insertText: `${option.name}: ${option.type === "boolean" ? "${1:true}" : "${1:90}"}`,
    detail: blockstateModelOptionDetails[option.name],
    kind: "property"
  }));

export const blockstatePredicateCompletions = [
  {
    label: "$state",
    detail: "Runtime block-state property namespace",
    kind: "constant"
  }
] as const satisfies readonly RsglCompletionCandidate[];

export function getBlockstateEntryCompletions(
  mode: BlockstateMode
): readonly RsglCompletionCandidate[] {
  return mode === "variants" ? variantsEntryCompletions : multipartEntryCompletions;
}
