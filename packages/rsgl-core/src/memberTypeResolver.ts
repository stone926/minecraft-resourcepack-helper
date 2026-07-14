import type { ExprNode, ObjectPropertyNode } from "./parser";
import { binaryOperatorResultType, unaryOperatorResultType } from "./semantic/operatorTypes";
import { resolveIndexType, staticIndexKey } from "./semantic/structuralTypes";
import { combineRsglTypes, inferListType } from "./semantic/typeNormalization";
import {
  anyType,
  inferLiteralType,
  missingType,
  objectProperty,
  RsglObjectProperty,
  RsglSemanticModel,
  RsglType,
  stringType,
  unknownType
} from "./semantic/types";

/** A field that is safe to access on every closed branch of the receiver. */
export interface ResolvedRsglMemberProperty {
  name: string;
  type: RsglType;
  optional: boolean;
  declarations: RsglObjectProperty[];
}

/** Best-effort expression typing for editor queries; it never performs binding. */
export function inferRsglToolingExpressionType(
  model: RsglSemanticModel,
  expression: ExprNode
): RsglType {
  if (expression.kind === "IdentifierExpr") {
    return symbolForIdentifier(model, expression)?.type ?? unknownType;
  }
  const resolvedType = model.resolvedExpressionTypes?.get(expression);
  if (resolvedType && !containsTypeParameter(resolvedType)) {
    return resolvedType;
  }
  if (expression.kind === "MemberExpr") {
    const receiver = inferRsglToolingExpressionType(model, expression.object);
    const property = resolveVisibleRsglMemberProperties(receiver)
      .find(candidate => candidate.name === expression.property.text);
    if (!property) {
      return unknownType;
    }
    return property.optional
      ? combineRsglTypes([property.type, missingType])
      : property.type;
  }
  if (expression.kind === "IndexExpr") {
    return resolveIndexType(
      inferRsglToolingExpressionType(model, expression.object),
      inferRsglToolingExpressionType(model, expression.index),
      staticIndexKey(expression.index)
    ).type;
  }
  if (expression.kind === "CallExpr") {
    if (expression.callee.kind === "IdentifierExpr") {
      const symbol = symbolForIdentifier(model, expression.callee);
      if (symbol?.signature) {
        return containsTypeParameter(symbol.signature.returnType)
          ? unknownType
          : symbol.signature.returnType;
      }
    }
    const callee = inferRsglToolingExpressionType(model, expression.callee);
    return callee.kind === "Function" ? callee.returnType ?? anyType : unknownType;
  }
  if (expression.kind === "ObjectExpr") {
    let properties = new Map<string, RsglObjectProperty>();
    let open = false;
    for (const entry of expression.properties) {
      if (entry.kind === "ObjectSpread") {
        const spreadType = inferRsglToolingExpressionType(model, entry.expression);
        const spreadShape = toolingObjectShape(spreadType);
        if (!spreadShape) {
          open = true;
          continue;
        }
        properties = mergeToolingProperties(properties, spreadShape.properties);
        open ||= spreadShape.open;
        continue;
      }
      const name = staticObjectKey(entry.key);
      if (name === undefined) {
        open = true;
        continue;
      }
      properties.set(name, objectProperty(inferRsglToolingExpressionType(model, entry.value)));
    }
    return { kind: "Object", properties, open };
  }
  if (expression.kind === "ListExpr") {
    return inferListType(expression.elements.map(element => {
      if (element.kind !== "ListSpread") {
        return inferRsglToolingExpressionType(model, element);
      }
      return toolingListElementType(
        inferRsglToolingExpressionType(model, element.expression)
      );
    }));
  }
  if (expression.kind === "ConditionalExpr") {
    return combineRsglTypes([
      inferRsglToolingExpressionType(model, expression.whenTrue),
      inferRsglToolingExpressionType(model, expression.whenFalse)
    ]);
  }
  if (expression.kind === "MatchExpr") {
    return combineRsglTypes(
      expression.arms.map(arm => inferRsglToolingExpressionType(model, arm.value))
    );
  }
  if (expression.kind === "LambdaExpr") {
    return {
      kind: "Function",
      parameters: expression.parameters.map(() => anyType),
      returnType: inferRsglToolingExpressionType(model, expression.body)
    };
  }
  if (expression.kind === "TemplateStringExpr") {
    return stringType;
  }
  if (expression.kind === "UnaryExpr") {
    return unaryOperatorResultType(expression.operator);
  }
  if (expression.kind === "BinaryExpr") {
    return binaryOperatorResultType(expression.operator);
  }
  return inferLiteralType(expression);
}

/** Intersects closed union shapes so completion never suggests an unsafe field. */
export function resolveVisibleRsglMemberProperties(
  type: RsglType
): ResolvedRsglMemberProperty[] {
  const branches = flattenUnion(type);
  if (branches.length === 0 || branches.some(branch => branch.kind !== "Object")) {
    return [];
  }
  const objectBranches = branches as Array<RsglType & { kind: "Object" }>;
  const firstNames = [...(objectBranches[0].properties?.keys() ?? [])];
  return firstNames
    .filter(name => objectBranches.every(branch => branch.properties?.has(name)))
    .map(name => {
      const declarations = objectBranches
        .map(branch => branch.properties?.get(name))
        .filter((property): property is RsglObjectProperty => Boolean(property));
      return {
        name,
        type: combineRsglTypes(declarations.map(property => property.type)),
        optional: declarations.some(property => property.optional),
        declarations
      };
    });
}

function symbolForIdentifier(
  model: RsglSemanticModel,
  expression: Extract<ExprNode, { kind: "IdentifierExpr" }>
) {
  return model.references.find(reference => sameRange(reference.range, expression.range))?.symbol
    ?? model.scope.symbols.get(expression.name.text);
}

function staticObjectKey(
  key: ObjectPropertyNode["key"]
): string | undefined {
  if (key.kind === "Identifier") {
    return key.text;
  }
  if (key.kind === "StringLiteral") {
    return key.value;
  }
  if (key.kind === "NumberLiteral") {
    return key.raw;
  }
  return undefined;
}

function toolingListElementType(type: RsglType): RsglType {
  const branches = flattenUnion(type);
  return branches.length > 0 && branches.every(branch => branch.kind === "List")
    ? combineRsglTypes(branches.map(branch => branch.elementType ?? unknownType))
    : unknownType;
}

function toolingObjectShape(type: RsglType): {
  properties: Map<string, RsglObjectProperty>;
  open: boolean;
} | undefined {
  const branches = flattenUnion(type);
  if (branches.length === 0 || branches.some(branch => branch.kind !== "Object")) {
    return undefined;
  }

  const objectBranches = branches as Array<RsglType & { kind: "Object" }>;
  const names = new Set(objectBranches.flatMap(branch => [
    ...(branch.properties?.keys() ?? [])
  ]));
  const properties = new Map<string, RsglObjectProperty>();
  for (const name of names) {
    const branchProperties = objectBranches
      .map(branch => branch.properties?.get(name))
      .filter((property): property is RsglObjectProperty => Boolean(property));
    properties.set(name, objectProperty(
      combineRsglTypes(branchProperties.map(property => property.type)),
      branchProperties.length < objectBranches.length
        || branchProperties.some(property => property.optional)
    ));
  }
  return {
    properties,
    open: objectBranches.some(branch => branch.open)
  };
}

function mergeToolingProperties(
  earlier: ReadonlyMap<string, RsglObjectProperty>,
  later: ReadonlyMap<string, RsglObjectProperty>
): Map<string, RsglObjectProperty> {
  const result = new Map(earlier);
  for (const [name, property] of later) {
    const previous = result.get(name);
    result.set(name, property.optional && previous
      ? objectProperty(
        combineRsglTypes([previous.type, property.type]),
        previous.optional
      )
      : property);
  }
  return result;
}

function flattenUnion(type: RsglType): RsglType[] {
  return type.kind === "Union"
    ? (type.options ?? []).flatMap(flattenUnion)
    : [type];
}

function containsTypeParameter(type: RsglType, seen = new Set<RsglType>()): boolean {
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);
  return type.kind === "TypeParameter"
    || Boolean(type.elementType && containsTypeParameter(type.elementType, seen))
    || Boolean(type.returnType && containsTypeParameter(type.returnType, seen))
    || Boolean(type.parameters?.some(parameter => containsTypeParameter(parameter, seen)))
    || Boolean(type.options?.some(option => containsTypeParameter(option, seen)))
    || Boolean(type.indexType && containsTypeParameter(type.indexType, seen))
    || Boolean(Array.from(type.properties?.values() ?? []).some(property =>
      containsTypeParameter(property.type, seen)
    ));
}

function sameRange(
  left: { start: number; end: number },
  right: { start: number; end: number }
): boolean {
  return left.start === right.start && left.end === right.end;
}
