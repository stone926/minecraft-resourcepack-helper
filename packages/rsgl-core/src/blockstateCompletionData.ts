import type { RsglCompletionCandidate } from "./completionData";
import type { BlockstateMode } from "./parser";

const variantsEntryCompletions = [
  {
    label: "variant entry",
    insertText: "${1:{}}: ${2:minecraft:block/stone}${3: x=90}",
    detail: "Blockstate variant entry",
    kind: "snippet"
  },
  {
    label: "random",
    insertText: "${1:{}}: random [\n  ${2:minecraft:block/stone} weight=${3:1}\n]",
    detail: "Random blockstate variant entry",
    kind: "snippet"
  }
] as const satisfies readonly RsglCompletionCandidate[];

const multipartEntryCompletions = [
  {
    label: "when",
    insertText: "when { ${1:facing}: ${2:north} } apply ${3:minecraft:block/stone}${4: x=90}",
    detail: "Conditional multipart entry",
    kind: "snippet"
  },
  {
    label: "apply",
    insertText: "apply ${1:minecraft:block/stone}${2: x=90}",
    detail: "Unconditional multipart entry",
    kind: "snippet"
  },
  {
    label: "random",
    insertText: "apply random [\n  ${1:minecraft:block/stone} weight=${2:1}\n]",
    detail: "Random multipart entry",
    kind: "snippet"
  }
] as const satisfies readonly RsglCompletionCandidate[];

export function getBlockstateEntryCompletions(
  mode: BlockstateMode
): readonly RsglCompletionCandidate[] {
  return mode === "variants" ? variantsEntryCompletions : multipartEntryCompletions;
}
