import { RsglType, unknownType } from "./types";

export function isAssignable(expected: RsglType, actual: RsglType): boolean {
  if (expected.kind === "Unknown" || expected.kind === "Any" || actual.kind === "Unknown" || actual.kind === "Any") {
    return true;
  }
  if (expected.kind === actual.kind) {
    return true;
  }
  if (expected.kind === "Json") {
    return true;
  }
  if (expected.kind === "ResourceId" && (actual.kind === "ModelId" || actual.kind === "TextureId" || actual.kind === "String")) {
    return true;
  }
  if ((expected.kind === "ModelId" || expected.kind === "TextureId") && actual.kind === "ResourceId") {
    return true;
  }
  return false;
}

export function formatType(type: RsglType): string {
  if (type.kind === "List") {
    return `List<${formatType(type.elementType ?? unknownType)}>`;
  }
  return type.kind;
}
