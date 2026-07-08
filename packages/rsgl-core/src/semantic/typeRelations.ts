import { RsglType, unknownType } from "./types";

export function isAssignable(expected: RsglType, actual: RsglType): boolean {
  if (expected.kind === "Unknown" || expected.kind === "Any" || actual.kind === "Unknown" || actual.kind === "Any") {
    return true;
  }
  if (expected.kind === actual.kind) {
    if (expected.kind === "Function" && actual.kind === "Function") {
      const expectedParameters = expected.parameters ?? [];
      const actualParameters = actual.parameters ?? [];
      if (expectedParameters.length > 0 && actualParameters.length > 0 && expectedParameters.length !== actualParameters.length) {
        return false;
      }
      if (expected.returnType && actual.returnType) {
        return isAssignable(expected.returnType, actual.returnType);
      }
    }
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
  if (type.kind === "Function" && type.parameters && type.returnType) {
    return `(${type.parameters.map(formatType).join(", ")}) -> ${formatType(type.returnType)}`;
  }
  return type.kind;
}
