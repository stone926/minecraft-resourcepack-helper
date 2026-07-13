import { RsglType, unknownType } from "./types";

export function isAssignable(expected: RsglType, actual: RsglType): boolean {
  if (expected.kind === "Unknown" || expected.kind === "Any" || actual.kind === "Unknown" || actual.kind === "Any") {
    return true;
  }
  if (actual.kind === "Union") {
    return (actual.options ?? []).every(option => isAssignable(expected, option));
  }
  if (expected.kind === "Union") {
    return (expected.options ?? []).some(option => isAssignable(option, actual));
  }
  if (expected.kind === actual.kind) {
    if (expected.kind === "List") {
      return isAssignable(expected.elementType ?? unknownType, actual.elementType ?? unknownType);
    }
    if (expected.kind === "Function") {
      if (expected.parameters && actual.parameters && expected.parameters.length !== actual.parameters.length) {
        return false;
      }
      if (expected.returnType && actual.returnType) {
        return isAssignable(expected.returnType, actual.returnType);
      }
    }
    return true;
  }
  if (expected.kind === "Json") {
    return actual.kind !== "TextureVariable" && actual.kind !== "TextureRef";
  }
  if (expected.kind === "ResourceId" && (actual.kind === "ModelId" || actual.kind === "TextureId" || actual.kind === "String")) {
    return true;
  }
  // Plain strings coerce to resource ids at evaluation time (namespace prefixing),
  // so String is accepted wherever a concrete id kind is expected.
  if ((expected.kind === "ModelId" || expected.kind === "TextureId") && (actual.kind === "ResourceId" || actual.kind === "String")) {
    return true;
  }
  if (expected.kind === "TextureRef") {
    return actual.kind === "TextureVariable"
      || actual.kind === "TextureId"
      || actual.kind === "ResourceId"
      || actual.kind === "String";
  }
  return false;
}

export function formatType(type: RsglType): string {
  if (type.kind === "Union") {
    return (type.options ?? []).map(formatType).join(" | ");
  }
  if (type.kind === "List") {
    return `List<${formatType(type.elementType ?? unknownType)}>`;
  }
  if (type.kind === "Function" && type.parameters && type.returnType) {
    return `(${type.parameters.map(formatType).join(", ")}) -> ${formatType(type.returnType)}`;
  }
  if (type.kind === "BlockstateModelObject") {
    return "blockstate model object";
  }
  return type.kind;
}
