import { minecraftResourceTarget } from "../../../packages/mc-assets/src";
import { getObjectString, JsonAstNode, stringValue } from "../jsonAst";
import { ResourceReference, ResourceReferenceKind, ResourceReferenceRelationship } from "./types";

export interface PushReferenceOptions {
  /** Overrides the extension derived from the reference kind. */
  extension?: string | null;
  relationship?: ResourceReferenceRelationship;
}

export function pushReference(
  references: ResourceReference[],
  valueNode: JsonAstNode,
  target: string,
  source: string,
  kind: "shader",
  options: PushReferenceOptions & { extension: string }
): void;
export function pushReference(
  references: ResourceReference[],
  valueNode: JsonAstNode,
  target: string,
  source: string,
  kind: Exclude<ResourceReferenceKind, "shader">,
  options?: PushReferenceOptions
): void;
export function pushReference(
  references: ResourceReference[],
  valueNode: JsonAstNode,
  target: string,
  source: string,
  kind: ResourceReferenceKind,
  options: PushReferenceOptions = {}
): void {
  const value = stringValue(valueNode);
  if (value === undefined) {
    return;
  }
  const extension = options.extension !== undefined
    ? options.extension
    : minecraftResourceTarget(kind).extension;
  const reference: ResourceReference = { value, valueNode, target, source, extension, kind };
  if (options.relationship) {
    reference.relationship = options.relationship;
  }
  references.push(reference);
}

export function getMinecraftType(node: JsonAstNode): string | null {
  const type = getObjectString(node, "type");
  if (!type) {
    return null;
  }

  return type.startsWith("minecraft:") ? type.slice("minecraft:".length) : type;
}
