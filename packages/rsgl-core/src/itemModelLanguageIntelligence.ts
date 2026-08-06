import { uniqueValues } from "../../mc-assets/src";
import type {
  ExprNode,
  ItemModelNode,
  ItemOptionNode,
  ObjectExprNode,
  ObjectPropertyNode,
  RsglModule,
  RsglStatement,
  RsglStatementBodyNode,
  TextRange
} from "./parser";
import { staticPropertyKeyName } from "./parser";
import {
  findItemModelPropertySchema,
  findItemModelSpecialSchema,
  findItemModelTintSchema,
  isItemModelSchemaEntryAvailable,
  itemModelPropertySchemas,
  itemModelRootFields,
  itemModelSpecialVariantsForTarget,
  projectItemModelSchemaVariants,
  type ItemModelFieldSchema,
  type ItemModelFormat,
  type ItemModelPropertySchema,
  type ItemModelSchemaLifecycle
} from "./itemModelSchema";
import { effectiveItemModelTargetFormat } from "./itemModelTarget";
import type { RsglHoverInfo } from "./languageIntelligence";
import { touchesRange } from "./textRangeQueries";

type PropertyFamily = keyof typeof itemModelPropertySchemas;

/** Resolves hover metadata owned by the target-aware item-model registry. */
export function getRsglItemModelHoverInfo(
  module: RsglModule,
  sourceText: string,
  offset: number,
  projectTargetFormat?: ItemModelFormat
): RsglHoverInfo | undefined {
  const target = effectiveItemModelTargetFormat(module, projectTargetFormat);
  let result: RsglHoverInfo | undefined;

  const select = (candidate: RsglHoverInfo | undefined): boolean => {
    if (candidate && !result) {
      result = candidate;
    }
    return Boolean(result);
  };

  const visitBody = (body: RsglStatementBodyNode, itemRoot: boolean): void => {
    for (const statement of body.statements) {
      visitStatement(statement, itemRoot);
      if (result) {
        return;
      }
    }
  };

  const visitStatement = (statement: RsglStatement, itemRoot: boolean): void => {
    if (result) {
      return;
    }
    switch (statement.kind) {
      case "ResourceDecl":
        visitBody(statement.body, statement.resourceKind === "item");
        return;
      case "TemplateDecl":
        visitBody(statement.body, false);
        return;
      case "OverlayDecl":
      case "ForStmt":
        visitBody(statement.body, itemRoot);
        return;
      case "IfStmt":
        visitBody(statement.thenBody, itemRoot);
        if (!result && statement.elseBody) {
          visitBody(statement.elseBody, itemRoot);
        }
        return;
      case "ItemModelProducerStmt":
        visitItemModel(statement.value);
        return;
      case "ItemSelectCase":
      case "ItemRangeEntry":
      case "ItemRangeFrames":
      case "ItemFallbackClause":
      case "ItemCompositeModel":
        visitItemModel(statement.model);
        return;
      case "ItemFirstMatchWhen":
        if (select(propertyHover("condition", statement.property, target, offset))) {
          return;
        }
        for (const option of statement.propertyOptions) {
          if (select(propertyOptionHover("condition", statement.property, option, target, offset))) {
            return;
          }
        }
        visitItemModel(statement.model);
        return;
      case "PropertyStmt":
        if (itemRoot && touchesRange(statement.key.range, offset)) {
          const name = staticPropertyKeyName(statement.key);
          const field = itemModelRootFields.find(candidate => candidate.name === name);
          if (field) {
            select(fieldHover(statement.key.range, field, "item definition root", target));
          }
        }
        return;
      default:
        return;
    }
  };

  const visitItemModel = (node: ItemModelNode): void => {
    if (result) {
      return;
    }
    if (select(constructorHover(node, sourceText, offset))) {
      return;
    }
    if ("options" in node && node.options) {
      if (select(postfixOptionsHover(node.options, target, offset))) {
        return;
      }
    }
    switch (node.kind) {
      case "ItemModelExpr":
      case "ItemModelUse":
      case "ItemModelEmpty":
      case "ItemModelSelectedItem":
        return;
      case "ItemModelSpecial":
        select(specialObjectHover(node.model, target, offset));
        return;
      case "ItemModelCondition":
        if (select(propertyHover("condition", node.property, target, offset))) {
          return;
        }
        for (const option of node.propertyOptions) {
          if (select(propertyOptionHover("condition", node.property, option, target, offset))) {
            return;
          }
        }
        if (node.onTrue) {
          visitItemModel(node.onTrue);
        }
        if (!result && node.onFalse) {
          visitItemModel(node.onFalse);
        }
        return;
      case "ItemModelSelect": {
        if (select(propertyHover("select", node.property, target, offset))) {
          return;
        }
        for (const option of node.propertyOptions) {
          if (select(propertyOptionHover("select", node.property, option, target, offset))) {
            return;
          }
        }
        const property = propertySchema("select", node.property);
        for (const statement of node.body.statements) {
          if (statement.kind === "ItemSelectCase" && touchesRange(statement.when.range, offset)) {
            select(selectWhenHover(statement.when.range, property, target));
            return;
          }
          visitStatement(statement, false);
          if (result) {
            return;
          }
        }
        return;
      }
      case "ItemModelRange":
        if (select(propertyHover("range_dispatch", node.property, target, offset))) {
          return;
        }
        for (const option of node.propertyOptions) {
          if (select(propertyOptionHover("range_dispatch", node.property, option, target, offset))) {
            return;
          }
        }
        visitBody(node.body, false);
        return;
      case "ItemModelComposite":
      case "ItemModelFirstMatch":
        visitBody(node.body, false);
        return;
      default:
        return assertNeverItemModel(node);
    }
  };

  for (const statement of module.statements) {
    visitStatement(statement, false);
    if (result) {
      break;
    }
  }
  return result;
}

function propertyHover(
  family: PropertyFamily,
  expression: ExprNode,
  target: ItemModelFormat | undefined,
  offset: number
): RsglHoverInfo | undefined {
  if (!touchesRange(expression.range, offset)) {
    return undefined;
  }
  const schema = propertySchema(family, expression);
  if (!schema) {
    return undefined;
  }
  const options = activePropertyFields(family, schema, target);
  const optionText = options.length > 0
    ? ` Options: ${options.map(field => `${field.name}${field.required ? " (required)" : ""}`).join(", ")}.`
    : " No property-specific options.";
  const exactMatch = family === "select" && schema.name === "component"
    ? " Component case values use complete equality, not subset matching."
    : "";
  return {
    range: expression.range,
    label: `item ${family} property minecraft:${schema.name}`,
    detail: `${availabilityDetail(schema, target)}${optionText}${exactMatch}`.trim()
  };
}

function propertyOptionHover(
  family: PropertyFamily,
  propertyExpression: ExprNode,
  option: ItemOptionNode,
  target: ItemModelFormat | undefined,
  offset: number
): RsglHoverInfo | undefined {
  if (!touchesRange(option.name.range, offset)) {
    return undefined;
  }
  const property = propertySchema(family, propertyExpression);
  const field = activePropertyFields(family, property, target)
    .find(candidate => candidate.name === option.name.text);
  return field
    ? fieldHover(option.name.range, field, `minecraft:${property?.name ?? "unknown"}`, target)
    : undefined;
}

function selectWhenHover(
  range: TextRange,
  property: ItemModelPropertySchema | undefined,
  target: ItemModelFormat | undefined
): RsglHoverInfo | undefined {
  if (!property) {
    return undefined;
  }
  const variants = property.whenVariants
    ? projectItemModelSchemaVariants(property.whenVariants, target).flatMap(item => item.values)
    : property.whenValues ?? [];
  const domain = variants.length > 0
    ? ` Allowed values: ${uniqueValues(variants).join(", ")}.`
    : "";
  const exactMatch = property.name === "component"
    ? " Component values are matched for complete equality, not as subsets."
    : "";
  return {
    range,
    label: `case <when> for minecraft:${property.name}`,
    detail: `${domain}${exactMatch}`.trim()
  };
}

function postfixOptionsHover(
  options: ObjectExprNode,
  target: ItemModelFormat | undefined,
  offset: number
): RsglHoverInfo | undefined {
  for (const entry of options.properties) {
    if (entry.kind !== "ObjectProperty") {
      continue;
    }
    const name = staticPropertyName(entry);
    if (touchesRange(entry.key.range, offset)) {
      if (name === "tints") {
        return {
          range: entry.key.range,
          label: "tints: List<TintSource>",
          detail: "Ordered model-leaf tint sources; list position is the model tintindex."
        };
      }
      if (name === "transformation") {
        return {
          range: entry.key.range,
          label: "transformation: Matrix4 | DecomposedTransformation",
          detail: `${target && target[0] < 83 ? "Unavailable for this target. " : ""}Available from pack format 83.0; matrices contain exactly 16 finite numbers.`
        };
      }
    }
    if (name === "tints" && entry.value.kind === "ListExpr") {
      for (const element of entry.value.elements) {
        if (element.kind === "ObjectExpr") {
          const hover = typedObjectHover(element, "tint", target, offset);
          if (hover) {
            return hover;
          }
        }
      }
    }
    if (name === "transformation" && entry.value.kind === "ObjectExpr") {
      const hover = transformationHover(entry.value, offset);
      if (hover) {
        return hover;
      }
    }
  }
  return undefined;
}

function specialObjectHover(
  expression: ExprNode,
  target: ItemModelFormat | undefined,
  offset: number
): RsglHoverInfo | undefined {
  return expression.kind === "ObjectExpr"
    ? typedObjectHover(expression, "special", target, offset)
    : undefined;
}

function typedObjectHover(
  object: ObjectExprNode,
  owner: "special" | "tint",
  target: ItemModelFormat | undefined,
  offset: number
): RsglHoverInfo | undefined {
  const typeEntry = object.properties.find((entry): entry is ObjectPropertyNode =>
    entry.kind === "ObjectProperty" && staticPropertyName(entry) === "type"
  );
  const subtype = typeEntry ? staticSchemaName(typeEntry.value) : undefined;
  if (typeEntry && touchesRange(typeEntry.value.range, offset) && subtype) {
    const schema = owner === "special"
      ? findItemModelSpecialSchema(subtype)
      : findItemModelTintSchema(subtype);
    return schema
      ? {
          range: typeEntry.value.range,
          label: `${owner} minecraft:${subtype}`,
          detail: availabilityDetail(schema, target)
        }
      : undefined;
  }
  const fields = owner === "special"
    ? specialFields(subtype, target)
    : tintFields(subtype, target);
  for (const entry of object.properties) {
    if (entry.kind !== "ObjectProperty" || !touchesRange(entry.key.range, offset)) {
      continue;
    }
    const name = staticPropertyName(entry);
    if (name === "type") {
      return {
        range: entry.key.range,
        label: "type: ResourceId",
        detail: `Required ${owner} subtype discriminator.`
      };
    }
    const field = fields.find(candidate => candidate.name === name);
    if (field) {
      return fieldHover(entry.key.range, field, `${owner} minecraft:${subtype ?? "unknown"}`, target);
    }
  }
  return undefined;
}

function transformationHover(object: ObjectExprNode, offset: number): RsglHoverInfo | undefined {
  const details = new Map<string, string>([
    ["right_rotation", "Quaternion [x,y,z,w] or { axis: [x,y,z], angle: radians }."],
    ["translation", "Exactly three finite numbers; default [0,0,0]."],
    ["left_rotation", "Quaternion [x,y,z,w] or { axis: [x,y,z], angle: radians }."],
    ["scale", "Exactly three finite numbers; default [1,1,1]."],
    ["axis", "Exactly three finite axis components."],
    ["angle", "Finite angle in radians."]
  ]);
  for (const entry of object.properties) {
    if (entry.kind !== "ObjectProperty") {
      continue;
    }
    const name = staticPropertyName(entry);
    if (name && touchesRange(entry.key.range, offset) && details.has(name)) {
      return { range: entry.key.range, label: `transformation.${name}`, detail: details.get(name) };
    }
    if (entry.value.kind === "ObjectExpr") {
      const nested = transformationHover(entry.value, offset);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

function constructorHover(
  node: ItemModelNode,
  sourceText: string,
  offset: number
): RsglHoverInfo | undefined {
  const keyword = new Map<ItemModelNode["kind"], string>([
    ["ItemModelRange", "range"],
    ["ItemModelSelect", "select"],
    ["ItemModelCondition", "condition"],
    ["ItemModelComposite", "composite"],
    ["ItemModelFirstMatch", "first_match"],
    ["ItemModelSpecial", "special"],
    ["ItemModelEmpty", "empty"],
    ["ItemModelSelectedItem", "selected_item"]
  ]).get(node.kind);
  if (!keyword || sourceText.slice(node.range.start, node.range.start + keyword.length) !== keyword) {
    return undefined;
  }
  const range = { start: node.range.start, end: node.range.start + keyword.length };
  if (!touchesRange(range, offset)) {
    return undefined;
  }
  return {
    range,
    label: `item model ${keyword}`,
    detail: keyword === "first_match"
      ? "Compile-time ordered condition chain, lowered once by right fold."
      : "Recursive Minecraft item-model constructor."
  };
}

function activePropertyFields(
  family: PropertyFamily,
  property: ItemModelPropertySchema | undefined,
  target: ItemModelFormat | undefined
): ItemModelFieldSchema[] {
  const fields = [
    ...itemModelPropertySchemas[family].commonFields,
    ...(property?.fields ?? [])
  ].filter(field => isItemModelSchemaEntryAvailable(field, target));
  return [...new Map(fields.map(field => [field.name, field])).values()];
}

function specialFields(
  subtype: string | undefined,
  target: ItemModelFormat | undefined
): ItemModelFieldSchema[] {
  const schema = subtype ? findItemModelSpecialSchema(subtype) : undefined;
  if (!schema) {
    return [];
  }
  return [...new Map(
    itemModelSpecialVariantsForTarget(schema, target)
      .flatMap(variant => variant.fields)
      .filter(field => isItemModelSchemaEntryAvailable(field, target))
      .map(field => [field.name, field])
  ).values()];
}

function tintFields(
  subtype: string | undefined,
  target: ItemModelFormat | undefined
): ItemModelFieldSchema[] {
  const schema = subtype ? findItemModelTintSchema(subtype) : undefined;
  return schema && isItemModelSchemaEntryAvailable(schema, target)
    ? schema.fields.filter(field => isItemModelSchemaEntryAvailable(field, target))
    : [];
}

function propertySchema(
  family: PropertyFamily,
  expression: ExprNode
): ItemModelPropertySchema | undefined {
  const name = staticSchemaName(expression);
  return name ? findItemModelPropertySchema(family, name) : undefined;
}

function fieldHover(
  range: TextRange,
  field: ItemModelFieldSchema,
  owner: string,
  target: ItemModelFormat | undefined
): RsglHoverInfo {
  const values = field.values?.length ? ` Values: ${field.values.join(", ")}.` : "";
  return {
    range,
    label: `${field.name}${field.required ? "" : "?"}: ${field.kind}`,
    detail: `${field.required ? "Required" : "Optional"} field for ${owner}. ${availabilityDetail(field, target)}${values}`.trim()
  };
}

function availabilityDetail(
  lifecycle: ItemModelSchemaLifecycle,
  target: ItemModelFormat | undefined
): string {
  if (target && !isItemModelSchemaEntryAvailable(lifecycle, target)) {
    return `Unavailable for target pack format ${target[0]}.${target[1]}.`;
  }
  const introduced = lifecycle.introduced
    ? `Available from pack format ${lifecycle.introduced[0]}.${lifecycle.introduced[1]}`
    : "Available in supported item-model formats";
  return lifecycle.removed
    ? `${introduced} until ${lifecycle.removed[0]}.${lifecycle.removed[1]} (exclusive).`
    : `${introduced}.`;
}

function staticSchemaName(expression: ExprNode): string | undefined {
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

function staticPropertyName(property: ObjectPropertyNode): string | undefined {
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

function assertNeverItemModel(value: never): never {
  throw new Error(`Unhandled item-model hover node: ${JSON.stringify(value)}`);
}
