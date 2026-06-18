import { parse, type AnyNode, type DocumentNode, type MemberNode } from "@humanwhocodes/momoa";

export type JsonAstNode = AnyNode;
export type JsonDocumentNode = DocumentNode;
export type JsonMemberNode = MemberNode;

export function parseJsonAst(text: string): DocumentNode | null {
  try {
    return parse(text);
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

function unwrapElement(node: JsonAstNode | null | undefined): JsonAstNode | null | undefined {
  return node?.type === "Element" ? node.value : node;
}
