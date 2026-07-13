import type { ExprNode } from "./parser";
import { binaryOperatorResultType, unaryOperatorResultType } from "./semantic/operatorTypes";
import { resolveIndexType, staticIndexKey } from "./semantic/structuralTypes";
import { combineRsglTypes } from "./semantic/typeNormalization";
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
        return symbol.signature.returnType;
      }
    }
    const callee = inferRsglToolingExpressionType(model, expression.callee);
    return callee.kind === "Function" ? callee.returnType ?? anyType : unknownType;
  }
  if (expression.kind === "ObjectExpr") {
    const properties = new Map<string, RsglObjectProperty>();
    let open = false;
    for (const property of expression.properties) {
      const name = staticObjectKey(property.key);
      if (name === undefined) {
        open = true;
        continue;
      }
      properties.set(name, objectProperty(inferRsglToolingExpressionType(model, property.value)));
    }
    return { kind: "Object", properties, open };
  }
  if (expression.kind === "ListExpr") {
    return {
      kind: "List",
      elementType: combineRsglTypes(
        expression.elements.map(element => inferRsglToolingExpressionType(model, element))
      )
    };
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
  key: Extract<ExprNode, { kind: "ObjectExpr" }>['properties'][number]['key']
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

function flattenUnion(type: RsglType): RsglType[] {
  return type.kind === "Union"
    ? (type.options ?? []).flatMap(flattenUnion)
    : [type];
}

function sameRange(
  left: { start: number; end: number },
  right: { start: number; end: number }
): boolean {
  return left.start === right.start && left.end === right.end;
}
