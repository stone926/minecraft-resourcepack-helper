import {
  BlockNode,
  BlockstateApplyValueNode,
  BlockstateMultipartRootBodyNode,
  BlockstateVariantsRootBodyNode,
  ExprNode,
  LegacyBlockstateRootBodyNode,
  MultipartBodyNode,
  ObjectPropertyNode,
  ResourceBodyNode,
  RsglModule,
  RsglStatement,
  TypeNode,
  VariantBodyNode
} from "./types";

export type RsglAstVisitControl = "skipChildren" | void;

export interface RsglAstVisitor {
  enterStatement?(statement: RsglStatement): RsglAstVisitControl;
  leaveStatement?(statement: RsglStatement): void;
  enterExpression?(expression: ExprNode): RsglAstVisitControl;
  leaveExpression?(expression: ExprNode): void;
  enterType?(type: TypeNode): RsglAstVisitControl;
  leaveType?(type: TypeNode): void;
}

type RsglBody =
  | BlockNode
  | ResourceBodyNode
  | VariantBodyNode
  | MultipartBodyNode
  | BlockstateVariantsRootBodyNode
  | BlockstateMultipartRootBodyNode
  | LegacyBlockstateRootBodyNode;

/**
 * Walks every statement and expression in deterministic structural order.
 * Consumers own semantic concerns such as scopes and source-order sorting.
 */
export function walkRsglModule(module: RsglModule, visitor: RsglAstVisitor): void {
  module.statements.forEach(statement => walkStatement(statement, visitor));
}

/** Walks an existing statement list without manufacturing a synthetic module. */
export function walkRsglStatements(
  statements: readonly RsglStatement[],
  visitor: RsglAstVisitor
): void {
  statements.forEach(statement => walkStatement(statement, visitor));
}

/** Walks one expression without requiring a synthetic module wrapper. */
export function walkRsglExpression(expression: ExprNode, visitor: RsglAstVisitor): void {
  walkExpression(expression, visitor);
}

/** Walks one type annotation or alias body in deterministic source order. */
export function walkRsglType(type: TypeNode, visitor: RsglAstVisitor): void {
  walkType(type, visitor);
}

function walkBody(body: RsglBody, visitor: RsglAstVisitor): void {
  body.statements.forEach(statement => walkStatement(statement, visitor));
}

function walkStatement(statement: RsglStatement, visitor: RsglAstVisitor): void {
  if (visitor.enterStatement?.(statement) === "skipChildren") {
    return;
  }

  switch (statement.kind) {
    case "TargetDecl":
      walkExpression(statement.value, visitor);
      break;
    case "NamespaceDecl":
      walkExpression(statement.name, visitor);
      break;
    case "ImportDecl":
    case "ExportDecl":
    case "ExternDecl":
    case "ExternVarStmt":
    case "ItemEmptyStmt":
    case "ItemSelectedItemStmt":
    case "UnknownStmt":
      break;
    case "TypeAliasDecl":
      walkType(statement.typeAnnotation, visitor);
      break;
    case "LetDecl":
      if (statement.typeAnnotation) {
        walkType(statement.typeAnnotation, visitor);
      }
      walkExpression(statement.value, visitor);
      break;
    case "TableDecl":
      walkExpression(statement.body, visitor);
      break;
    case "TemplateDecl":
      statement.parameters.forEach(parameter => {
        if (parameter.typeAnnotation) {
          walkType(parameter.typeAnnotation, visitor);
        }
        if (parameter.defaultValue) {
          walkExpression(parameter.defaultValue, visitor);
        }
      });
      walkBody(statement.body, visitor);
      break;
    case "ResourceDecl":
      if (statement.id) {
        walkExpression(statement.id, visitor);
      }
      if (statement.impl) {
        walkExpression(statement.impl, visitor);
      }
      walkBody(statement.body, visitor);
      break;
    case "OverlayDecl":
      walkExpression(statement.directory, visitor);
      if (statement.formatRange) {
        walkExpression(statement.formatRange, visitor);
      }
      walkBody(statement.body, visitor);
      break;
    case "UseDecl":
      walkExpression(statement.expression, visitor);
      break;
    case "ForStmt":
      if (statement.dimensions.length > 0) {
        statement.dimensions.forEach(dimension => walkExpression(dimension.iterable, visitor));
      } else {
        walkExpression(statement.iterable, visitor);
      }
      walkBody(statement.body, visitor);
      break;
    case "IfStmt":
      walkExpression(statement.condition, visitor);
      walkBody(statement.thenBody, visitor);
      if (statement.elseBody) {
        walkBody(statement.elseBody, visitor);
      }
      break;
    case "PropertyStmt":
      walkExpression(statement.value, visitor);
      break;
    case "SectionStmt":
      if (statement.value) {
        walkExpression(statement.value, visitor);
      }
      if (statement.body) {
        walkBody(statement.body, visitor);
      }
      break;
    case "VariantsSection":
    case "MultipartSection":
      statement.entries.forEach(entry => walkStatement(entry, visitor));
      break;
    case "VariantEntry":
      walkExpression(statement.state, visitor);
      walkExpression(statement.value, visitor);
      break;
    case "BlockstateVariantEntry":
      walkExpression(statement.selector, visitor);
      walkBlockstateApplyValue(statement.value, visitor);
      break;
    case "MultipartEntry":
      if (statement.when) {
        walkExpression(statement.when, visitor);
      }
      walkExpression(statement.apply, visitor);
      break;
    case "BlockstateMultipartEntry":
      if (statement.when) {
        walkExpression(statement.when, visitor);
      }
      walkBlockstateApplyValue(statement.apply, visitor);
      break;
    case "PackFormatsStmt":
      if (statement.min) {
        walkExpression(statement.min, visitor);
      }
      if (statement.max) {
        walkExpression(statement.max, visitor);
      }
      break;
    case "PackOverlayStmt":
      walkExpression(statement.directory, visitor);
      walkBody(statement.body, visitor);
      break;
    case "PackFilterBlockStmt":
    case "AtlasFilterStmt":
      if (statement.namespace) {
        walkExpression(statement.namespace, visitor);
      }
      if (statement.path) {
        walkExpression(statement.path, visitor);
      }
      break;
    case "AtlasDirectoryStmt":
      if (statement.source) {
        walkExpression(statement.source, visitor);
      }
      if (statement.prefix) {
        walkExpression(statement.prefix, visitor);
      }
      break;
    case "AtlasPalettedPermutationsStmt":
      walkBody(statement.body, visitor);
      break;
    case "EquipmentLayerStmt":
      walkExpression(statement.layer, visitor);
      if (statement.texture) {
        walkExpression(statement.texture, visitor);
      }
      if (statement.dyeable) {
        walkExpression(statement.dyeable, visitor);
      }
      if (statement.color) {
        walkExpression(statement.color, visitor);
      }
      if (statement.usePlayerTexture) {
        walkExpression(statement.usePlayerTexture, visitor);
      }
      break;
    case "ModelTextureStmt":
      walkExpression(statement.value, visitor);
      break;
    case "ModelElementStmt":
      if (statement.label) {
        walkExpression(statement.label, visitor);
      }
      if (statement.from) {
        walkExpression(statement.from, visitor);
      }
      if (statement.to) {
        walkExpression(statement.to, visitor);
      }
      statement.properties.forEach(property => walkExpression(property.value, visitor));
      statement.faces.forEach(face => face.properties.forEach(property => walkExpression(property.value, visitor)));
      break;
    case "ItemRangeStmt":
      walkExpression(statement.property, visitor);
      statement.options.forEach(option => walkExpression(option.value, visitor));
      if (statement.frames) {
        walkExpression(statement.frames.frames, visitor);
        walkExpression(statement.frames.model, visitor);
      }
      if (statement.fallback) {
        walkExpression(statement.fallback, visitor);
      }
      break;
    case "ItemSelectStmt":
      walkExpression(statement.property, visitor);
      statement.options.forEach(option => walkExpression(option.value, visitor));
      statement.cases.forEach(item => {
        walkExpression(item.when, visitor);
        walkExpression(item.model, visitor);
      });
      if (statement.fallback) {
        walkExpression(statement.fallback, visitor);
      }
      break;
    case "ItemConditionStmt":
      walkExpression(statement.property, visitor);
      statement.options.forEach(option => walkExpression(option.value, visitor));
      if (statement.onTrue) {
        walkExpression(statement.onTrue, visitor);
      }
      if (statement.onFalse) {
        walkExpression(statement.onFalse, visitor);
      }
      break;
    case "ItemCompositeStmt":
      statement.models.forEach(model => walkExpression(model, visitor));
      break;
    case "ItemSpecialStmt":
      walkExpression(statement.base, visitor);
      walkExpression(statement.model, visitor);
      break;
    case "BaseStmt":
      walkExpression(statement.path, visitor);
      break;
    case "MergeStmt":
      walkExpression(statement.value, visitor);
      break;
    default:
      assertNever(statement);
  }

  visitor.leaveStatement?.(statement);
}

function walkBlockstateApplyValue(
  value: BlockstateApplyValueNode,
  visitor: RsglAstVisitor
): void {
  if (value.kind === "BlockstateApplyExpr") {
    walkExpression(value.head, visitor);
    value.properties.forEach(property => walkExpression(property.value, visitor));
    return;
  }
  value.items.forEach(item => {
    walkExpression(item.head, visitor);
    item.properties.forEach(property => walkExpression(property.value, visitor));
  });
}

function walkExpression(expression: ExprNode, visitor: RsglAstVisitor): void {
  if (visitor.enterExpression?.(expression) === "skipChildren") {
    return;
  }

  switch (expression.kind) {
    case "IdentifierExpr":
    case "StringLiteral":
    case "NumberLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
    case "ResourceLocationExpr":
    case "MissingExpr":
      break;
    case "TemplateStringExpr":
      expression.parts.forEach(part => {
        if (part.kind === "expression") {
          walkExpression(part.expression, visitor);
        }
      });
      break;
    case "ListExpr":
      expression.elements.forEach(element => walkExpression(element, visitor));
      break;
    case "ObjectExpr":
      expression.properties.forEach(property => walkObjectProperty(property, visitor));
      break;
    case "StateKeySugar":
      expression.entries.forEach(property => walkObjectProperty(property, visitor));
      break;
    case "RangeExpr":
      walkExpression(expression.startExpr, visitor);
      walkExpression(expression.endExpr, visitor);
      break;
    case "CallExpr":
      walkExpression(expression.callee, visitor);
      expression.args.forEach(argument => walkExpression(argument.value, visitor));
      break;
    case "MemberExpr":
      walkExpression(expression.object, visitor);
      break;
    case "IndexExpr":
      walkExpression(expression.object, visitor);
      walkExpression(expression.index, visitor);
      break;
    case "UnaryExpr":
      walkExpression(expression.operand, visitor);
      break;
    case "BinaryExpr":
      walkExpression(expression.left, visitor);
      walkExpression(expression.right, visitor);
      break;
    case "ConditionalExpr":
      walkExpression(expression.condition, visitor);
      walkExpression(expression.whenTrue, visitor);
      walkExpression(expression.whenFalse, visitor);
      break;
    case "LambdaExpr":
      walkExpression(expression.body, visitor);
      break;
    case "MatchExpr":
      walkExpression(expression.expression, visitor);
      expression.arms.forEach(arm => {
        arm.patterns.forEach(pattern => walkExpression(pattern, visitor));
        walkExpression(arm.value, visitor);
      });
      break;
    case "ForInExpr":
      walkExpression(expression.iterable, visitor);
      break;
    case "ModelApplySugar":
      walkExpression(expression.model, visitor);
      expression.properties.forEach(property => walkExpression(property.value, visitor));
      break;
    case "RandomApply":
      expression.entries.forEach(entry => walkExpression(entry, visitor));
      break;
    default:
      assertNever(expression);
  }

  visitor.leaveExpression?.(expression);
}

function walkObjectProperty(
  property: ObjectPropertyNode,
  visitor: RsglAstVisitor
): void {
  if (property.key.kind === "DynamicKey") {
    walkExpression(property.key.expression, visitor);
  }
  walkExpression(property.value, visitor);
}

function walkType(type: TypeNode, visitor: RsglAstVisitor): void {
  if (visitor.enterType?.(type) === "skipChildren") {
    return;
  }

  switch (type.kind) {
    case "NamedType":
    case "LiteralType":
    case "MissingType":
      break;
    case "GenericType":
      type.args.forEach(argument => walkType(argument, visitor));
      break;
    case "FunctionType":
      type.parameters.forEach(parameter => walkType(parameter, visitor));
      walkType(type.returnType, visitor);
      break;
    case "UnionType":
      type.options.forEach(option => walkType(option, visitor));
      break;
    case "ObjectType":
      type.properties.forEach(property => walkType(property.typeAnnotation, visitor));
      break;
    default:
      assertNever(type);
  }

  visitor.leaveType?.(type);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled RSGL AST node: ${JSON.stringify(value)}`);
}
