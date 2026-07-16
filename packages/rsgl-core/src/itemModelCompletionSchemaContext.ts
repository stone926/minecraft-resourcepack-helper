import { isObjectPropertyKeyPosition } from "./completionObjectContext";
import {
  type ExprNode,
  type ItemModelNode,
  type ItemOptionNode,
  type ObjectExprNode,
  type ObjectPropertyNode,
  type RsglStatement
} from "./parser";

export type RsglItemModelPropertyFamily = "condition" | "select" | "range_dispatch";

/** Fine-grained schema slot layered on top of the structural item-model owner. */
export type RsglItemModelSchemaCompletionContext =
  | { kind: "propertyName"; family: RsglItemModelPropertyFamily }
  | {
      kind: "propertyOptionName";
      family: RsglItemModelPropertyFamily;
      propertyName?: string;
      writtenKeys: readonly string[];
    }
  | {
      kind: "propertyOptionValue";
      family: RsglItemModelPropertyFamily;
      propertyName?: string;
      optionName: string;
    }
  | { kind: "selectWhen"; propertyName?: string }
  | { kind: "specialType" }
  | { kind: "specialFieldName"; subtype?: string; writtenKeys: readonly string[] }
  | { kind: "specialFieldValue"; subtype?: string; fieldName: string }
  | { kind: "tintType" }
  | { kind: "tintFieldName"; subtype?: string; writtenKeys: readonly string[] }
  | { kind: "tintFieldValue"; subtype?: string; fieldName: string }
  | { kind: "transformationFieldName"; writtenKeys: readonly string[] }
  | { kind: "rotationFieldName"; writtenKeys: readonly string[] };

export function isItemModelSchemaCompletionKeyPosition(
  kind: RsglItemModelSchemaCompletionContext["kind"] | undefined
): boolean {
  return kind === "propertyOptionName"
    || kind === "specialFieldName"
    || kind === "tintFieldName"
    || kind === "transformationFieldName"
    || kind === "rotationFieldName";
}

export function itemModelSchemaContextForNode(
  node: ItemModelNode,
  prefix: string,
  openBrace: number
): RsglItemModelSchemaCompletionContext | undefined {
  const objectContext = itemModelObjectSchemaContext(node, prefix, openBrace);
  if (objectContext) {
    return objectContext;
  }
  switch (node.kind) {
    case "ItemModelSelect":
      return propertyHeaderCompletionContext(
        "select",
        node.property,
        node.propertyOptions,
        prefix,
        itemBodyHasNotStarted(node.body.range.start, prefix)
      );
    case "ItemModelRange":
      return propertyHeaderCompletionContext(
        "range_dispatch",
        node.property,
        node.propertyOptions,
        prefix,
        itemBodyHasNotStarted(node.body.range.start, prefix)
      );
    case "ItemModelCondition":
      return propertyHeaderCompletionContext(
        "condition",
        node.property,
        node.propertyOptions,
        prefix,
        conditionBodyHasNotStarted(node.property, node.propertyOptions, prefix)
      );
    case "ItemModelExpr":
    case "ItemModelUse":
    case "ItemModelComposite":
    case "ItemModelFirstMatch":
    case "ItemModelEmpty":
    case "ItemModelSelectedItem":
    case "ItemModelSpecial":
      return undefined;
    default:
      return assertNeverItemModel(node);
  }
}

export function firstMatchHeaderCompletionContext(
  statement: Extract<RsglStatement, { kind: "ItemFirstMatchWhen" }>,
  prefix: string
): RsglItemModelSchemaCompletionContext | undefined {
  return propertyHeaderCompletionContext(
    "condition",
    statement.property,
    statement.propertyOptions,
    prefix,
    !mappingArrowFollowsHeader(statement.propertyOptions, statement.property, prefix)
  );
}

export function selectWhenCompletionContext(
  statement: Extract<RsglStatement, { kind: "ItemSelectCase" }>,
  prefix: string,
  propertyName: string | undefined
): RsglItemModelSchemaCompletionContext | undefined {
  const afterWhen = prefix.slice(statement.when.range.end);
  if (afterWhen.includes("=>") || afterWhen.trim().length !== 0) {
    return undefined;
  }
  if (statement.model.kind !== "ItemModelExpr" || statement.model.expression.kind !== "MissingExpr") {
    return undefined;
  }
  return { kind: "selectWhen", propertyName };
}

export function staticItemModelObjectKeys(object: ObjectExprNode): string[] {
  return object.properties.flatMap(entry => {
    if (entry.kind !== "ObjectProperty") {
      return [];
    }
    const name = staticObjectPropertyName(entry);
    return name ? [name] : [];
  });
}

export function staticItemModelSchemaName(expression: ExprNode): string | undefined {
  let value: string | undefined;
  if (expression.kind === "ResourceLocationExpr") {
    value = expression.value;
  } else if (expression.kind === "IdentifierExpr") {
    value = expression.name.text;
  } else if (expression.kind === "StringLiteral") {
    value = expression.value;
  }
  return value?.startsWith("minecraft:") ? value.slice("minecraft:".length) : value;
}

function propertyHeaderCompletionContext(
  family: RsglItemModelPropertyFamily,
  property: ExprNode,
  options: readonly ItemOptionNode[],
  prefix: string,
  headerIsActive: boolean
): RsglItemModelSchemaCompletionContext | undefined {
  if (!headerIsActive) {
    return undefined;
  }
  const headerEnd = itemHeaderEnd(property, options);
  if (prefix.slice(headerEnd).trim().length !== 0) {
    return undefined;
  }
  const endsInWhitespace = /\s$/.test(prefix);
  if (property.kind === "MissingExpr" || (!endsInWhitespace && prefix.length <= property.range.end)) {
    return { kind: "propertyName", family };
  }
  const propertyName = staticItemModelSchemaName(property);
  const lastOption = options.at(-1);
  if (lastOption && (
    lastOption.value.kind === "MissingExpr"
    || (!endsInWhitespace && prefix.length <= lastOption.value.range.end)
  )) {
    return {
      kind: "propertyOptionValue",
      family,
      propertyName,
      optionName: lastOption.name.text
    };
  }
  return {
    kind: "propertyOptionName",
    family,
    propertyName,
    writtenKeys: options.map(option => option.name.text)
  };
}

function itemModelObjectSchemaContext(
  node: ItemModelNode,
  prefix: string,
  openBrace: number
): RsglItemModelSchemaCompletionContext | undefined {
  if (node.kind === "ItemModelSpecial" && node.model.kind === "ObjectExpr") {
    const special = typedObjectCompletionContext(node.model, prefix, openBrace, "special");
    if (special) {
      return special;
    }
  }
  if (!("options" in node) || !node.options) {
    return undefined;
  }
  const tints = objectProperty(node.options, "tints")?.value;
  if (tints?.kind === "ListExpr") {
    for (const element of tints.elements) {
      if (element.kind !== "ObjectExpr") {
        continue;
      }
      const tint = typedObjectCompletionContext(element, prefix, openBrace, "tint");
      if (tint) {
        return tint;
      }
    }
  }
  const transformation = objectProperty(node.options, "transformation")?.value;
  if (transformation?.kind === "ObjectExpr") {
    if (transformation.range.start === openBrace) {
      return isObjectPropertyKeyPosition(prefix.slice(openBrace + 1))
        ? {
            kind: "transformationFieldName",
            writtenKeys: staticItemModelObjectKeys(transformation)
          }
        : undefined;
    }
    for (const rotationName of ["right_rotation", "left_rotation"] as const) {
      const rotation = objectProperty(transformation, rotationName)?.value;
      if (rotation?.kind === "ObjectExpr" && rotation.range.start === openBrace) {
        return isObjectPropertyKeyPosition(prefix.slice(openBrace + 1))
          ? { kind: "rotationFieldName", writtenKeys: staticItemModelObjectKeys(rotation) }
          : undefined;
      }
    }
  }
  return undefined;
}

function typedObjectCompletionContext(
  object: ObjectExprNode,
  prefix: string,
  openBrace: number,
  owner: "special" | "tint"
): RsglItemModelSchemaCompletionContext | undefined {
  if (object.range.start !== openBrace) {
    return undefined;
  }
  const typeProperty = objectProperty(object, "type");
  const subtype = typeProperty ? staticItemModelSchemaName(typeProperty.value) : undefined;
  if (isObjectPropertyKeyPosition(prefix.slice(openBrace + 1))) {
    return owner === "special"
      ? { kind: "specialFieldName", subtype, writtenKeys: staticItemModelObjectKeys(object) }
      : { kind: "tintFieldName", subtype, writtenKeys: staticItemModelObjectKeys(object) };
  }
  const active = activeObjectProperty(object, prefix.length);
  const fieldName = active && staticObjectPropertyName(active);
  if (!fieldName) {
    return undefined;
  }
  if (fieldName === "type") {
    return owner === "special" ? { kind: "specialType" } : { kind: "tintType" };
  }
  return owner === "special"
    ? { kind: "specialFieldValue", subtype, fieldName }
    : { kind: "tintFieldValue", subtype, fieldName };
}

function activeObjectProperty(
  object: ObjectExprNode,
  cursor: number
): ObjectPropertyNode | undefined {
  for (let index = object.properties.length - 1; index >= 0; index--) {
    const property = object.properties[index];
    if (property.kind !== "ObjectProperty") {
      continue;
    }
    if (property.value.kind === "MissingExpr" || property.value.range.end >= cursor) {
      return property;
    }
    if (index === object.properties.length - 1) {
      return property;
    }
  }
  return undefined;
}

function objectProperty(object: ObjectExprNode, name: string): ObjectPropertyNode | undefined {
  return object.properties.find((entry): entry is ObjectPropertyNode =>
    entry.kind === "ObjectProperty" && staticObjectPropertyName(entry) === name
  );
}

function staticObjectPropertyName(property: ObjectPropertyNode): string | undefined {
  if (property.key.kind === "Identifier") {
    return property.key.text;
  }
  if (property.key.kind === "StringLiteral") {
    return property.key.value;
  }
  if (property.key.kind === "NumberLiteral") {
    return String(property.key.value);
  }
  return undefined;
}

function itemHeaderEnd(property: ExprNode, options: readonly ItemOptionNode[]): number {
  return options.at(-1)?.range.end ?? property.range.end;
}

function itemBodyHasNotStarted(bodyStart: number, prefix: string): boolean {
  return bodyStart >= prefix.length || prefix[bodyStart] !== "{";
}

function conditionBodyHasNotStarted(
  property: ExprNode,
  options: readonly ItemOptionNode[],
  prefix: string
): boolean {
  return !prefix.slice(itemHeaderEnd(property, options)).trimStart().startsWith("{");
}

function mappingArrowFollowsHeader(
  options: readonly ItemOptionNode[],
  property: ExprNode,
  prefix: string
): boolean {
  return prefix.slice(itemHeaderEnd(property, options)).includes("=>");
}

function assertNeverItemModel(value: never): never {
  throw new Error(`Unhandled item-model schema completion node: ${JSON.stringify(value)}`);
}
