import type { TextRange } from "../parser";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { combineRsglTypes } from "./typeNormalization";
import { inferredUnionBudgetOptions } from "./unionBudget";
import {
  neverType,
  objectProperty,
  RsglObjectProperty,
  RsglType,
  unknownType
} from "./types";

export function recordProjectionElements(
  record: RsglType,
  operation: "entries" | "keys" | "values"
): RsglType[] {
  if (record.open) {
    if (operation === "keys") {
      return [{ kind: "String" }];
    }
    const valueTypes = [
      ...(record.properties?.values() ?? [])
    ].map(property => withoutMissing(property.type));
    if (record.indexType) {
      valueTypes.push(withoutMissing(record.indexType));
    }
    const valueType = valueTypes.length > 0
      ? combineRsglTypes(valueTypes)
      : unknownType;
    if (operation === "values") {
      return [valueType];
    }
    return [entryType({ kind: "String" }, valueType)];
  }

  const result: RsglType[] = [];
  for (const [name, property] of record.properties ?? []) {
    const valueType = withoutMissing(property.type);
    if (operation === "keys") {
      result.push({ kind: "String", literalValue: name });
    } else if (operation === "values") {
      result.push(valueType);
    } else {
      result.push(entryType({ kind: "String", literalValue: name }, valueType));
    }
  }
  return result;
}

function entryType(keyType: RsglType, valueType: RsglType): RsglType {
  return {
    kind: "Object",
    properties: new Map([
      ["key", objectProperty(keyType)],
      ["value", objectProperty(valueType)]
    ]),
    open: false
  };
}

export interface RsglObjectMergeContext {
  context: RsglExpressionCheckContext;
  range: TextRange;
}

/** Cartesian record composition capped after every source operand. */
export function mergeObjectTypeAlternatives(
  owner: RsglObjectMergeContext,
  earlier: readonly RsglType[],
  later: readonly RsglType[]
): RsglType[] {
  const merged = earlier.flatMap(left =>
    later.map(right => mergeObjectTypes(owner, left, right))
  );
  const bounded = combineRsglTypes(
    merged,
    false,
    inferredUnionBudgetOptions(owner.context.diagnostics, owner.range)
  );
  return bounded.kind === "Union"
    ? bounded.options ?? []
    : [bounded];
}

/** Shallow, left-to-right record merge used by mergeObjects and object spread. */
export function mergeObjectTypes(
  owner: RsglObjectMergeContext,
  earlier: RsglType,
  later: RsglType
): RsglType {
  const properties = new Map<string, RsglObjectProperty>();
  for (const [name, property] of earlier.properties ?? []) {
    properties.set(name, { ...property });
  }

  if (later.open && later.indexType) {
    for (const [name, property] of properties) {
      properties.set(name, objectProperty(
        combineRsglTypes(
          [property.type, later.indexType],
          false,
          inferredUnionBudgetOptions(owner.context.diagnostics, owner.range)
        ),
        property.optional,
        property.declarationRange
      ));
    }
  }

  for (const [name, property] of later.properties ?? []) {
    const previous = properties.get(name);
    if (!property.optional) {
      properties.set(name, { ...property, optional: false });
      continue;
    }
    const fallback = previous?.type ?? earlier.indexType;
    properties.set(name, objectProperty(
      fallback
        ? combineRsglTypes(
          [fallback, property.type],
          false,
          inferredUnionBudgetOptions(owner.context.diagnostics, owner.range)
        )
        : property.type,
      previous ? previous.optional : true,
      property.declarationRange ?? previous?.declarationRange
    ));
  }

  const indexTypes = [earlier.indexType, later.indexType]
    .filter((type): type is RsglType => Boolean(type));
  return {
    kind: "Object",
    properties,
    open: Boolean(earlier.open || later.open),
    ...(indexTypes.length > 0
      ? {
        indexType: combineRsglTypes(
          indexTypes,
          false,
          inferredUnionBudgetOptions(owner.context.diagnostics, owner.range)
        )
      }
      : {})
  };
}

/** Expected-record projection that never requires one merge/spread operand to provide every field. */
export function optionalObjectProjection(type: RsglType): RsglType | undefined {
  const expected = expectedObjectType(type);
  if (!expected) {
    return undefined;
  }
  return {
    ...expected,
    properties: new Map(Array.from(expected.properties ?? []).map(([name, property]) => [
      name,
      { ...property, optional: true }
    ]))
  };
}

export function expectedObjectType(type: RsglType | undefined): RsglType | undefined {
  if (type?.kind === "Object") {
    return type;
  }
  if (type?.kind !== "Union") {
    return undefined;
  }
  const objects = (type.options ?? []).filter(option => option.kind === "Object");
  return objects.length === 1 ? objects[0] : undefined;
}

function withoutMissing(type: RsglType): RsglType {
  if (type.kind !== "Union") {
    return type.kind === "Missing" ? neverType : type;
  }
  const present = (type.options ?? []).filter(option => option.kind !== "Missing");
  return present.length === 0 ? neverType : combineRsglTypes(present);
}
