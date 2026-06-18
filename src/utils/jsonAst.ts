const { parse } = require("@humanwhocodes/momoa");

export type JsonAstNode = any;

export function parseJsonAst(text: string): JsonAstNode | null {
  try {
    return parse(text);
  } catch {
    return null;
  }
}

export function objectMembers(node: JsonAstNode | null | undefined): JsonAstNode[] {
  return node?.type === "Object" && Array.isArray(node.members) ? node.members : [];
}

export function arrayElements(node: JsonAstNode | null | undefined): JsonAstNode[] {
  return node?.type === "Array" && Array.isArray(node.elements) ? node.elements : [];
}

export function memberName(member: JsonAstNode | null | undefined): string | undefined {
  return typeof member?.name?.value === "string" ? member.name.value : undefined;
}

export function stringValue(node: JsonAstNode | null | undefined): string | undefined {
  return node?.type === "String" && typeof node.value === "string" ? node.value : undefined;
}
