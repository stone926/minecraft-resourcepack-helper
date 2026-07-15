import { hasLiteralValue, RsglObjectProperty, RsglType, unknownType } from "./types";

export function isAssignable(expected: RsglType, actual: RsglType): boolean {
  if (actual.kind === "Never") {
    return true;
  }
  if (expected.kind === "Never") {
    return false;
  }
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
    if (expected.kind === "ModuleNamespace") {
      return expected.moduleNamespaceId !== undefined
        && expected.moduleNamespaceId === actual.moduleNamespaceId;
    }
    if (expected.kind === "TypeParameter") {
      return expected.typeParameterName === actual.typeParameterName;
    }
    if (
      expected.kind === "Json"
      && expected.contextualEscapeOnly
      && actual.explicitAnnotation !== true
    ) {
      return false;
    }
    if (hasLiteralValue(expected)) {
      return hasLiteralValue(actual) && Object.is(expected.literalValue, actual.literalValue);
    }
    if (expected.kind === "List" || expected.kind === "Range") {
      return isAssignable(expected.elementType ?? unknownType, actual.elementType ?? unknownType);
    }
    if (expected.kind === "Object") {
      return isObjectAssignable(expected, actual);
    }
    if (expected.kind === "Function") {
      if (expected.parameters && actual.parameters && expected.parameters.length !== actual.parameters.length) {
        return false;
      }
      if (expected.parameters && actual.parameters) {
        for (let index = 0; index < expected.parameters.length; index++) {
          const expectedParameter = expected.parameters[index];
          const actualParameter = actual.parameters[index];
          // Parameter invariance is intentionally conservative for the first
          // complete Function relation; return values remain covariant.
          if (!isAssignable(expectedParameter, actualParameter)
            || !isAssignable(actualParameter, expectedParameter)) {
            return false;
          }
        }
      }
      if (expected.returnType && actual.returnType) {
        return isAssignable(expected.returnType, actual.returnType);
      }
    }
    return true;
  }
  if (expected.kind === "Json") {
    if (expected.contextualEscapeOnly) {
      return actual.kind === "Json" && actual.explicitAnnotation === true;
    }
    return actual.kind !== "TextureVariable"
      && actual.kind !== "TextureRef"
      && actual.kind !== "StatePredicate"
      && actual.kind !== "ModuleNamespace"
      && actual.kind !== "Missing";
  }
  if (expected.kind === "ResourceId" && (actual.kind === "ModelId" || actual.kind === "TextureId")) {
    return true;
  }
  if (expected.kind === "TextureRef") {
    return actual.kind === "TextureVariable"
      || actual.kind === "TextureId";
  }
  return false;
}

export function formatType(type: RsglType): string {
  if (hasLiteralValue(type)) {
    return JSON.stringify(type.literalValue);
  }
  if (type.kind === "Union") {
    return (type.options ?? []).map(formatType).join(" | ");
  }
  if (type.kind === "List") {
    return `List<${formatType(type.elementType ?? unknownType)}>`;
  }
  if (type.kind === "Function" && type.parameters && type.returnType) {
    return `(${type.parameters.map(formatType).join(", ")}) -> ${formatType(type.returnType)}`;
  }
  if (type.kind === "TypeParameter") {
    return type.typeParameterName ?? "?";
  }
  if (type.kind === "ModuleNamespace") {
    return "module namespace";
  }
  if (type.kind === "Object") {
    const fields = Array.from(type.properties ?? [])
      .map(([name, property]) => `${name}${property.optional ? "?" : ""}: ${formatType(property.type)}`)
    return fields.length > 0 ? `{ ${fields.join(", ")} }` : "{}";
  }
  return type.kind;
}

function isObjectAssignable(expected: RsglType, actual: RsglType): boolean {
  const expectedProperties = expected.properties ?? new Map<string, RsglObjectProperty>();
  const actualProperties = actual.properties ?? new Map<string, RsglObjectProperty>();
  for (const [name, expectedProperty] of expectedProperties) {
    const actualProperty = actualProperties.get(name);
    const actualPropertyType = actualProperty?.type ?? actual.indexType;
    if (!actualPropertyType) {
      if (expectedProperty.optional) {
        continue;
      }
      return false;
    }
    if (!expectedProperty.optional && actualProperty?.optional) {
      return false;
    }
    if (!isAssignable(expectedProperty.type, actualPropertyType)) {
      return false;
    }
  }

  if (expected.indexType) {
    for (const actualProperty of actualProperties.values()) {
      if (!isAssignable(expected.indexType, actualProperty.type)) {
        return false;
      }
    }
    if (actual.indexType && !isAssignable(expected.indexType, actual.indexType)) {
      return false;
    }
  }
  return true;
}
