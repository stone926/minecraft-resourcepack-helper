import {
  resourceValueKindForTypeKind,
  typeKindForResourceValueKind,
  type RsglResourceValueKind
} from "../resourceIdSemantics";
import type { RsglNode } from "../parser";
import { diagnostic } from "./diagnostics";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { formatType, isAssignable } from "./typeRelations";
import type { RsglType } from "./types";

export function checkAssignable(
  context: RsglExpressionCheckContext,
  expected: RsglType,
  actual: RsglType,
  node: RsglNode
): void {
  if (containsMissingType(actual)) {
    // The member/index checker already emitted optionalFieldMayBeMissing at
    // the access. A second generic mismatch at the enclosing sink obscures
    // the actionable guard diagnostic.
    return;
  }
  if (expected.kind === "Json" && containsModuleNamespaceType(actual)) {
    context.diagnostics.push(diagnostic(
      "rsgl.moduleNamespaceValueNotSerializable",
      "A module namespace cannot be serialized as JSON; select one of its exported values.",
      node.range
    ));
    return;
  }
  if (isAssignable(expected, actual)) {
    return;
  }
  const expectedResourceKind = singleExpectedResourceValueKind(expected);
  const actualResourceKind = resourceValueKindForTypeKind(actual.kind);
  if (expectedResourceKind && (actualResourceKind || actual.kind === "TextureVariable")) {
    context.diagnostics.push(diagnostic(
      "rsgl.resourceIdKindMismatch",
      `${actualResourceKind ? typeKindForResourceValueKind(actualResourceKind) : "TextureVariable"} cannot be used where ${typeKindForResourceValueKind(expectedResourceKind)} is required.`,
      node.range
    ));
    return;
  }
  context.diagnostics.push(diagnostic(
    "rsgl.typeMismatch",
    `Expected ${formatType(expected)}, got ${formatType(actual)}.`,
    node.range
  ));
}

function containsModuleNamespaceType(type: RsglType, seen = new Set<RsglType>()): boolean {
  if (type.kind === "ModuleNamespace") {
    return true;
  }
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);
  if (type.kind === "Union") {
    return (type.options ?? []).some(option => containsModuleNamespaceType(option, seen));
  }
  if (type.kind === "List") {
    return type.elementType
      ? containsModuleNamespaceType(type.elementType, seen)
      : false;
  }
  if (type.kind === "Object") {
    return Array.from(type.properties?.values() ?? [])
      .some(property => containsModuleNamespaceType(property.type, seen))
      || Boolean(type.indexType && containsModuleNamespaceType(type.indexType, seen));
  }
  return false;
}

function singleExpectedResourceValueKind(type: RsglType): RsglResourceValueKind | undefined {
  const direct = resourceValueKindForTypeKind(type.kind);
  if (direct) {
    return direct;
  }
  if (type.kind === "TextureRef" || type.kind === "TextureVariable") {
    return "texture";
  }
  if (type.kind !== "Union") {
    return undefined;
  }
  const kinds = new Set(
    (type.options ?? [])
      .map(singleExpectedResourceValueKind)
      .filter((kind): kind is RsglResourceValueKind => Boolean(kind))
  );
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

function containsMissingType(type: RsglType): boolean {
  return type.kind === "Missing"
    || (type.kind === "Union" && (type.options ?? []).some(containsMissingType));
}
