import { JsonAstNode, memberName, objectMembers, stringValue } from "../jsonAst";
import { ResourceReference, ResourceReferenceKind, ResourceReferenceRelationship } from "./types";

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

export function getObjectString(node: JsonAstNode, name: string): string | null {
  return stringValue(getObjectMemberValue(node, name)) ?? null;
}

export function getObjectMemberValue(node: JsonAstNode, name: string): JsonAstNode | null {
  return objectMembers(node).find(item => memberName(item) === name)?.value ?? null;
}

export function getMinecraftType(node: JsonAstNode): string | null {
  const type = getObjectString(node, "type");
  if (!type) {
    return null;
  }

  return type.startsWith("minecraft:") ? type.slice("minecraft:".length) : type;
}
