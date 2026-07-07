import { getObjectMemberValue, getObjectString, JsonAstNode, stringValue } from "../jsonAst";
import { ResourceReference, ResourceReferenceKind, ResourceReferenceRelationship } from "./types";

export { getObjectMemberValue, getObjectString };

export function pushReference(
  references: ResourceReference[],
  valueNode: JsonAstNode,
  target: string,
  source: string,
  extension: string | null,
  kind: ResourceReferenceKind,
  relationship?: ResourceReferenceRelationship
): void {
  const value = stringValue(valueNode);
  if (value !== undefined) {
    const reference: ResourceReference = { value, valueNode, target, source, extension, kind };
    if (relationship) {
      reference.relationship = relationship;
    }
    references.push(reference);
  }
}

export function getMinecraftType(node: JsonAstNode): string | null {
  const type = getObjectString(node, "type");
  if (!type) {
    return null;
  }

  return type.startsWith("minecraft:") ? type.slice("minecraft:".length) : type;
}
