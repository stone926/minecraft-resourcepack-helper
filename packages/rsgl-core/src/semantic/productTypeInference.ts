import { RsglUnionBudgetOptions, combineRsglTypes, rsglTypeKey } from "./typeNormalization";
import {
  anyType,
  jsonType,
  objectProperty,
  RsglObjectProperty,
  RsglType,
  unknownType
} from "./types";

export interface RsglProductSourceIssue {
  kind: "sourceNotIterable";
  propertyName?: string;
  actualType: RsglType;
  declarationRange?: RsglObjectProperty["declarationRange"];
}

export interface RsglProductTypeResult {
  type: RsglType;
  issues: RsglProductSourceIssue[];
}

interface ProductElementResult {
  type: RsglType;
  issues: RsglProductSourceIssue[];
}

interface ProductDimensionResult {
  type: RsglType;
  invalidTypes: RsglType[];
}

/**
 * Infers the structural rows produced by the cartesian-product builtin.
 * The implementation is independent from call binding and expression checking:
 * callers provide the already-checked source type and map issues to source ranges.
 */
export function inferProductType(
  sourceType: RsglType,
  budgetOptions?: RsglUnionBudgetOptions
): RsglProductTypeResult {
  const element = inferProductElementType(sourceType, budgetOptions);
  return {
    type: { kind: "List", elementType: element.type },
    issues: deduplicateProductIssues(element.issues)
  };
}

function inferProductElementType(
  sourceType: RsglType,
  budgetOptions?: RsglUnionBudgetOptions
): ProductElementResult {
  if (sourceType.kind === "Union") {
    const results = (sourceType.options ?? [])
      .map(option => inferProductElementType(option, budgetOptions));
    return {
      type: combineRsglTypes(results.map(result => result.type), false, budgetOptions),
      issues: results.flatMap(result => result.issues)
    };
  }

  if (sourceType.kind === "Object") {
    return inferProductObjectType(sourceType, budgetOptions);
  }

  if (sourceType.kind === "Any") {
    return { type: dynamicProductRow(anyType), issues: [] };
  }
  if (sourceType.kind === "Json") {
    return { type: dynamicProductRow(jsonType), issues: [] };
  }
  if (sourceType.kind === "Unknown") {
    return { type: dynamicProductRow(unknownType), issues: [] };
  }

  return {
    type: dynamicProductRow(unknownType),
    issues: [{ kind: "sourceNotIterable", actualType: sourceType }]
  };
}

function inferProductObjectType(
  sourceType: RsglType,
  budgetOptions?: RsglUnionBudgetOptions
): ProductElementResult {
  const properties = new Map<string, RsglObjectProperty>();
  const issues: RsglProductSourceIssue[] = [];

  for (const [name, property] of sourceType.properties ?? []) {
    const dimension = inferProductDimensionType(property.type, budgetOptions);
    properties.set(name, objectProperty(
      dimension.type,
      property.optional,
      property.declarationRange
    ));
    if (dimension.invalidTypes.length > 0) {
      issues.push({
        kind: "sourceNotIterable",
        propertyName: name,
        actualType: combineInvalidProductSourceTypes(dimension.invalidTypes, budgetOptions),
        declarationRange: property.declarationRange
      });
    }
  }

  let indexType: RsglType | undefined;
  if (sourceType.indexType) {
    const dimension = inferProductDimensionType(sourceType.indexType, budgetOptions);
    indexType = dimension.type;
    if (dimension.invalidTypes.length > 0) {
      issues.push({
        kind: "sourceNotIterable",
        actualType: combineInvalidProductSourceTypes(dimension.invalidTypes, budgetOptions)
      });
    }
  } else if (sourceType.open) {
    indexType = unknownType;
  }

  return {
    type: {
      kind: "Object",
      properties,
      open: sourceType.open === true || sourceType.indexType !== undefined,
      ...(indexType ? { indexType } : {})
    },
    issues
  };
}

function inferProductDimensionType(
  sourceType: RsglType,
  budgetOptions?: RsglUnionBudgetOptions
): ProductDimensionResult {
  if (sourceType.kind === "Union") {
    const results = (sourceType.options ?? [])
      .map(option => inferProductDimensionType(option, budgetOptions));
    return {
      type: combineRsglTypes(results.map(result => result.type), false, budgetOptions),
      invalidTypes: results.flatMap(result => result.invalidTypes)
    };
  }
  if (sourceType.kind === "List" || sourceType.kind === "Range") {
    return {
      type: sourceType.elementType ?? unknownType,
      invalidTypes: []
    };
  }
  if (sourceType.kind === "Any") {
    return { type: anyType, invalidTypes: [] };
  }
  if (sourceType.kind === "Json") {
    return { type: jsonType, invalidTypes: [] };
  }
  if (sourceType.kind === "Unknown") {
    return { type: unknownType, invalidTypes: [] };
  }
  return { type: unknownType, invalidTypes: [sourceType] };
}

function dynamicProductRow(indexType: RsglType): RsglType {
  return {
    kind: "Object",
    properties: new Map(),
    indexType,
    open: true
  };
}

function combineInvalidProductSourceTypes(
  types: readonly RsglType[],
  budgetOptions?: RsglUnionBudgetOptions
): RsglType {
  return combineRsglTypes(types, false, { maxArms: budgetOptions?.maxArms });
}

function deduplicateProductIssues(issues: readonly RsglProductSourceIssue[]): RsglProductSourceIssue[] {
  const unique = new Map<string, RsglProductSourceIssue>();
  for (const issue of issues) {
    const range = issue.declarationRange;
    const key = [
      issue.propertyName ?? "<dynamic>",
      rsglTypeKey(issue.actualType),
      range?.start ?? -1,
      range?.end ?? -1
    ].join(":");
    unique.set(key, issue);
  }
  return Array.from(unique.values());
}
