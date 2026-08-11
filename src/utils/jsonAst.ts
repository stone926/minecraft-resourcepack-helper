import {
  parse,
  type AnyNode,
  type DocumentNode,
  type MemberNode,
  type ParseOptions
} from "@humanwhocodes/momoa";

export type JsonAstNode = AnyNode;
export type JsonDocumentNode = DocumentNode;
export type JsonMemberNode = MemberNode;

export function parseJsonAst(text: string, options?: ParseOptions): DocumentNode | null {
  try {
    return parse(text, options);
  } catch {
    return null;
  }
}

export function objectMembers(node: JsonAstNode | null | undefined): MemberNode[] {
  const unwrappedNode = unwrapElement(node);
  return unwrappedNode?.type === "Object" ? unwrappedNode.members : [];
}

export function arrayElements(node: JsonAstNode | null | undefined): JsonAstNode[] {
  const unwrappedNode = unwrapElement(node);
  return unwrappedNode?.type === "Array" ? unwrappedNode.elements : [];
}

export function getObjectMember(node: JsonAstNode | null | undefined, name: string): MemberNode | null {
  return objectMembers(node).find(member => memberName(member) === name) ?? null;
}

export function getObjectMemberValue(node: JsonAstNode | null | undefined, name: string): JsonAstNode | null {
  return getObjectMember(node, name)?.value ?? null;
}

export function getObjectString(node: JsonAstNode | null | undefined, name: string): string | null {
  return stringValue(getObjectMemberValue(node, name)) ?? null;
}

export function memberName(member: JsonAstNode | null | undefined): string | undefined {
  if (member?.type !== "Member") {
    return undefined;
  }

  if (member.name.type === "String") {
    return member.name.value;
  }

  return member.name.name;
}

export function stringValue(node: JsonAstNode | null | undefined): string | undefined {
  const unwrappedNode = unwrapElement(node);
  return unwrappedNode?.type === "String" ? unwrappedNode.value : undefined;
}

export function numberValue(node: JsonAstNode | null | undefined): number | undefined {
  const unwrappedNode = unwrapElement(node);
  return unwrappedNode?.type === "Number" ? unwrappedNode.value : undefined;
}

export function booleanValue(node: JsonAstNode | null | undefined): boolean | undefined {
  const unwrappedNode = unwrapElement(node);
  return unwrappedNode?.type === "Boolean" ? unwrappedNode.value : undefined;
}

function unwrapElement(node: JsonAstNode | null | undefined): JsonAstNode | null | undefined {
  return node?.type === "Element" ? node.value : node;
}
