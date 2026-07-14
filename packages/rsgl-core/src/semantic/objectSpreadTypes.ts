import type { RsglDiagnostic, RsglNode } from "../parser";
import { diagnostic } from "./diagnostics";
import { formatType } from "./typeRelations";
import type { RsglType } from "./types";

interface ObjectSpreadDiagnosticSink {
  diagnostics: RsglDiagnostic[];
}

/**
 * Resolves the runtime-safe record arms of an object spread.
 *
 * Keeping this shape gate shared prevents contextual object literals and
 * domain-specific blockstate objects from disagreeing about unions whose every
 * branch is an object. Dynamic values remain an open record; mixed unions are
 * rejected because at least one runtime branch would not be spreadable.
 */
export function objectSpreadTypes(
  context: ObjectSpreadDiagnosticSink,
  type: RsglType,
  spread: RsglNode
): RsglType[] | undefined {
  if (type.kind === "Object") {
    return [type];
  }
  if (type.kind === "Unknown" || type.kind === "Any") {
    return [dynamicObjectType(type)];
  }
  if (type.kind === "Union") {
    const options = type.options ?? [];
    if (options.every(option => option.kind === "Object")) {
      return options;
    }
  }
  context.diagnostics.push(diagnostic(
    "rsgl.invalidObjectSpread",
    `Object spread requires an Object value, got ${formatType(type)}.`,
    spread.range
  ));
  return undefined;
}

function dynamicObjectType(indexType: RsglType): RsglType {
  return {
    kind: "Object",
    properties: new Map(),
    indexType,
    open: true
  };
}
