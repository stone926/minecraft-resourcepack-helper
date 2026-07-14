import {
  anyType,
  jsonType,
  missingType,
  neverType,
  objectProperty,
  RsglType,
  unknownType
} from "./types";

export const defaultRsglUnionArmBudget = 128;

export interface RsglUnionWidening {
  armCount: number;
  budget: number;
  widenedType: RsglType;
}

/** Opt-in budget for inferred unions. Explicit source annotations never pass this option. */
export interface RsglUnionBudgetOptions {
  maxArms?: number;
  onWiden?: (widening: RsglUnionWidening) => void;
}

/**
 * Produces a stable structural identity for an RSGL type. The identity is
 * intentionally independent of declaration/insertion order so inferred
 * unions are deterministic across single-file and linked-program binding.
 */
export function rsglTypeKey(type: RsglType): string {
  return rsglTypeKeyInternal(type, new Set());
}

/** Recursively normalizes containers and canonicalizes every nested union. */
export function normalizeRsglType(type: RsglType): RsglType {
  switch (type.kind) {
    case "List":
    case "Range":
      return {
        ...type,
        elementType: normalizeRsglType(type.elementType ?? unknownType)
      };
    case "Object": {
      const properties = new Map(
        Array.from(type.properties ?? [])
          .map(([name, property]) => [name, {
            ...property,
            type: normalizeRsglType(property.type)
          }] as const)
      );
      return {
        ...type,
        properties,
        indexType: type.indexType ? normalizeRsglType(type.indexType) : undefined
      };
    }
    case "Function":
      return {
        ...type,
        parameters: type.parameters?.map(normalizeRsglType),
        returnType: type.returnType ? normalizeRsglType(type.returnType) : undefined
      };
    case "Union":
      return combineRsglTypes(type.options ?? [], type.explicitAnnotation === true);
    default:
      return type;
  }
}

/**
 * Flattens, recursively normalizes, structurally deduplicates, and sorts a
 * group of possible types. `Any` and `Unknown` retain their existing wildcard
 * semantics and therefore absorb a union that contains them.
 */
export function combineRsglTypes(
  types: readonly RsglType[],
  explicitlyAnnotated = false,
  budgetOptions?: RsglUnionBudgetOptions
): RsglType {
  const flattened: RsglType[] = [];
  let inheritedExplicitAnnotation = explicitlyAnnotated;

  const append = (type: RsglType): void => {
    inheritedExplicitAnnotation ||= type.explicitAnnotation === true;
    if (type.kind === "Union") {
      for (const option of type.options ?? []) {
        append(option);
      }
      return;
    }
    flattened.push(normalizeRsglType(type));
  };
  types.forEach(append);

  if (flattened.length === 0) {
    return inheritedExplicitAnnotation
      ? { ...unknownType, explicitAnnotation: true }
      : unknownType;
  }
  const present = flattened.filter(type => type.kind !== "Never");
  if (present.length === 0) {
    return inheritedExplicitAnnotation
      ? { ...neverType, explicitAnnotation: true }
      : neverType;
  }
  if (present.some(type => type.kind === "Any")) {
    return inheritedExplicitAnnotation
      ? { ...anyType, explicitAnnotation: true }
      : anyType;
  }
  if (present.some(type => type.kind === "Unknown")) {
    return inheritedExplicitAnnotation
      ? { ...unknownType, explicitAnnotation: true }
      : unknownType;
  }

  const unique = new Map<string, RsglType>();
  for (const type of present) {
    const key = rsglTypeKey(type);
    const existing = unique.get(key);
    if (!existing || type.explicitAnnotation === true) {
      unique.set(key, type);
    }
  }
  const options = Array.from(unique.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, type]) => type);

  if (options.length === 1) {
    return inheritedExplicitAnnotation
      ? { ...options[0], explicitAnnotation: true }
      : options[0];
  }
  const budget = Math.max(2, budgetOptions?.maxArms ?? defaultRsglUnionArmBudget);
  if (budgetOptions && options.length > budget) {
    const widenedType = preserveExplicitAnnotation(
      widenUnionOptions(options, budget),
      inheritedExplicitAnnotation
    );
    budgetOptions.onWiden?.({ armCount: options.length, budget, widenedType });
    return widenedType;
  }
  return {
    kind: "Union",
    options,
    ...(inheritedExplicitAnnotation ? { explicitAnnotation: true as const } : {})
  };
}

export function inferListType(
  elementTypes: readonly RsglType[],
  budgetOptions?: RsglUnionBudgetOptions
): RsglType {
  return {
    kind: "List",
    elementType: elementTypes.length === 0
      ? neverType
      : combineRsglTypes(elementTypes, false, budgetOptions)
  };
}

function widenUnionOptions(options: readonly RsglType[], budget: number): RsglType {
  const hasMissing = options.some(option => option.kind === "Missing");
  if (hasMissing) {
    const present = options.filter(option => option.kind !== "Missing");
    if (present.length === 0) {
      return missingType;
    }
    return combineRsglTypes([
      widenUnionOptions(present, budget),
      missingType
    ]);
  }

  const firstKind = options[0]?.kind;
  if (firstKind && options.every(option => option.kind === firstKind)) {
    if (isScalarKind(firstKind)) {
      return { kind: firstKind };
    }
    if (firstKind === "Object") {
      return widenObjectUnion(options, budget);
    }
    if (firstKind === "List" || firstKind === "Range") {
      return {
        kind: firstKind,
        elementType: combineRsglTypes(
          options.map(option => option.elementType ?? unknownType),
          false,
          { maxArms: budget }
        )
      };
    }
    if (firstKind === "Function") {
      return { kind: "Function" };
    }
  }

  return options.every(isJsonCompatibleType) ? jsonType : unknownType;
}

function widenObjectUnion(options: readonly RsglType[], budget: number): RsglType {
  const objects = options.filter((option): option is RsglType & { kind: "Object" } => option.kind === "Object");
  const firstNames = Array.from(objects[0]?.properties?.keys() ?? []);
  const commonNames = firstNames.filter(name =>
    objects.every(object => object.properties?.has(name))
  );
  const properties = new Map(commonNames.map(name => {
    const sourceProperties = objects.map(object => object.properties!.get(name)!);
    return [name, objectProperty(
      combineRsglTypes(
        sourceProperties.map(property => property.type),
        false,
        { maxArms: budget }
      ),
      sourceProperties.some(property => property.optional),
      sourceProperties.find(property => property.declarationRange)?.declarationRange
    )] as const;
  }));
  const indexTypes = objects
    .map(object => object.indexType)
    .filter((type): type is RsglType => Boolean(type));
  return {
    kind: "Object",
    properties,
    open: true,
    ...(indexTypes.length === objects.length
      ? {
          indexType: combineRsglTypes(indexTypes, false, { maxArms: budget })
        }
      : {})
  };
}

function preserveExplicitAnnotation(type: RsglType, explicit: boolean): RsglType {
  return explicit ? { ...type, explicitAnnotation: true } : type;
}

function isScalarKind(kind: RsglType["kind"]): boolean {
  return kind === "String"
    || kind === "Number"
    || kind === "Boolean"
    || kind === "Null"
    || kind === "Path"
    || kind === "ResourceId"
    || kind === "ModelId"
    || kind === "TextureId"
    || kind === "TextureVariable"
    || kind === "TextureRef"
    || kind === "Json"
    || kind === "BlockstateModelObject";
}

function isJsonCompatibleType(type: RsglType): boolean {
  if (type.kind === "Function" || type.kind === "Missing" || type.kind === "Unknown") {
    return false;
  }
  if (type.kind === "Union") {
    return (type.options ?? []).every(isJsonCompatibleType);
  }
  return true;
}

function rsglTypeKeyInternal(type: RsglType, ancestors: Set<RsglType>): string {
  if (ancestors.has(type)) {
    return `${type.kind}<recursive>`;
  }
  const nextAncestors = new Set(ancestors).add(type);
  switch (type.kind) {
    case "List":
    case "Range":
      return `${type.kind}<${rsglTypeKeyInternal(type.elementType ?? unknownType, nextAncestors)}>`;
    case "Object": {
      const properties = Array.from(type.properties ?? [])
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, property]) =>
          `${JSON.stringify(name)}${property.optional ? "?" : ""}:${rsglTypeKeyInternal(property.type, nextAncestors)}`
        )
        .join(",");
      const index = type.indexType
        ? `[key]:${rsglTypeKeyInternal(type.indexType, nextAncestors)}`
        : "";
      return `Object${type.open ? "<open>" : ""}{${properties}${properties && index ? "," : ""}${index}}`;
    }
    case "Function": {
      const parameters = (type.parameters ?? [])
        .map(parameter => rsglTypeKeyInternal(parameter, nextAncestors))
        .join(",");
      const returnType = rsglTypeKeyInternal(type.returnType ?? unknownType, nextAncestors);
      return `Function<(${parameters})->${returnType}>`;
    }
    case "Union": {
      const options = (type.options ?? [])
        .map(option => rsglTypeKeyInternal(option, nextAncestors))
        .sort((left, right) => left.localeCompare(right));
      return `Union<${Array.from(new Set(options)).join("|")}>`;
    }
    case "TypeParameter":
      return `TypeParameter<${type.typeParameterName ?? "?"}>`;
    default:
      return type.contextualEscapeOnly
        ? `${type.kind}<contextual-escape-only>`
        : Object.prototype.hasOwnProperty.call(type, "literalValue")
          ? `${type.kind}<${JSON.stringify(type.literalValue)}>`
          : type.kind;
  }
}
