import {
  BlockNode,
  ExprNode,
  ForStmtNode,
  IdentifierNode,
  MultipartBodyNode,
  MultipartSectionStatementNode,
  ResourceBodyNode,
  ResourceStatementNode,
  TopLevelStatementNode,
  VariantBodyNode,
  VariantSectionStatementNode
} from "../parser";
import { diagnostic } from "./diagnostics";
import { finiteStringDomain } from "./domainChecks";
import {
  checkEquipmentLayerListExpression,
  checkEquipmentLayerNameExpression,
  checkExpression,
  checkLocalLetDecl,
  checkStringEnumLikeExpression,
  RsglExpressionCheckContext,
  validateResourceLocationLike
} from "./expressionChecker";
import { createChildScope, lookup } from "./scopes";
import { anyType, numberType, RsglScope, RsglType, stringType, unknownType } from "./types";

type CheckableBody = ResourceBodyNode | BlockNode | VariantBodyNode | MultipartBodyNode;

export type RsglBlockStatementChecker = (
  statements: TopLevelStatementNode[],
  scope: RsglScope
) => void;

/** Checks all scope-sensitive statements nested below a top-level declaration. */
export class RsglResourceBodyChecker {
  public constructor(
    private readonly context: RsglExpressionCheckContext,
    private readonly checkBlockStatements: RsglBlockStatementChecker
  ) { }

  public checkBody(body: CheckableBody, scope: RsglScope): void {
    switch (body.kind) {
      case "ResourceBody":
        this.checkResourceBody(body, scope);
        break;
      case "Block":
        this.checkBlockStatements(body.statements, scope);
        break;
      case "VariantBody":
        this.checkVariantStatements(body.statements, scope);
        break;
      case "MultipartBody":
        this.checkMultipartStatements(body.statements, scope);
        break;
      default:
        assertNever(body);
    }
  }

  public checkResourceBody(body: ResourceBodyNode, scope: RsglScope, owner = "resource"): void {
    for (const statement of body.statements) {
      this.checkResourceStatement(statement, scope, owner);
    }
  }

  public checkForStatement(statement: ForStmtNode, scope: RsglScope): void {
    const loopScope = createChildScope(scope, "loop");
    const seen = new Set<string>();
    const forDimensions = statement.dimensions.length ? statement.dimensions : [{
      kind: "ForDimension" as const,
      bindings: statement.bindings,
      iterable: statement.iterable,
      range: statement.range,
      fullRange: statement.fullRange
    }];
    for (const dimension of forDimensions) {
      this.checkForIterableExpression(dimension.iterable, loopScope);
      const finiteDomain = dimension.bindings.length === 1 ? finiteStringDomain(dimension.iterable, loopScope) : null;
      for (const binding of dimension.bindings) {
        if (seen.has(binding.text)) {
          this.context.diagnostics.push(diagnostic("rsgl.duplicateLoopBinding", `Duplicate loop binding '${binding.text}'.`, binding.range));
        }
        seen.add(binding.text);
        this.context.defineIdentifier(loopScope, binding, "variable", anyType, binding);
        if (finiteDomain) {
          const symbol = lookup(loopScope, binding.text);
          if (symbol) {
            symbol.finiteDomain = finiteDomain;
          }
        }
      }
    }
    this.checkBody(statement.body, loopScope);
  }

  private checkResourceStatement(statement: ResourceStatementNode, scope: RsglScope, owner: string): void {
    switch (statement.kind) {
      case "PropertyStmt":
        if (owner === "equipment" && statement.name.text === "layers") {
          checkEquipmentLayerListExpression(this.context, statement.value, scope);
        } else if (owner === "scaling" && statement.name.text === "type") {
          checkStringEnumLikeExpression(this.context, statement.value, scope);
        } else {
          this.checkExpression(statement.value, scope);
        }
        validateResourceLocationLike(this.context, statement.value);
        break;
      case "SectionStmt":
        if (statement.value) {
          if (owner === "equipment" && statement.name.text === "layers") {
            checkEquipmentLayerListExpression(this.context, statement.value, scope);
          } else if (owner === "scaling" && statement.name.text === "type") {
            checkStringEnumLikeExpression(this.context, statement.value, scope);
          } else {
            this.checkExpression(statement.value, scope);
          }
        }
        if (statement.body) {
          this.checkResourceBody(statement.body, createChildScope(scope, "block"), statement.name.text);
        }
        break;
      case "VariantsSection":
        this.checkVariantStatements(statement.entries, scope);
        break;
      case "MultipartSection":
        this.checkMultipartStatements(statement.entries, scope);
        break;
      case "VariantEntry":
        this.checkExpression(statement.state, scope);
        this.checkExpression(statement.value, scope);
        break;
      case "MultipartEntry":
        if (statement.when) {
          this.checkExpression(statement.when, scope);
        }
        this.checkExpression(statement.apply, scope);
        break;
      case "UseDecl":
        this.checkExpression(statement.expression, scope);
        break;
      case "LetDecl":
        checkLocalLetDecl(this.context, statement, scope);
        break;
      case "PackFormatsStmt":
        if (statement.min) {
          this.checkExpression(statement.min, scope);
        }
        if (statement.max) {
          this.checkExpression(statement.max, scope);
        }
        break;
      case "PackOverlayStmt":
        this.checkExpression(statement.directory, scope);
        this.checkResourceBody(statement.body, createChildScope(scope, "block"), "packOverlay");
        break;
      case "PackFilterBlockStmt":
        if (statement.namespace) {
          this.checkExpression(statement.namespace, scope);
        }
        if (statement.path) {
          this.checkExpression(statement.path, scope);
        }
        break;
      case "AtlasDirectoryStmt":
        if (statement.source) {
          this.checkExpression(statement.source, scope);
        }
        if (statement.prefix) {
          this.checkExpression(statement.prefix, scope);
        }
        break;
      case "AtlasFilterStmt":
        if (statement.namespace) {
          this.checkExpression(statement.namespace, scope);
        }
        if (statement.path) {
          this.checkExpression(statement.path, scope);
        }
        break;
      case "AtlasPalettedPermutationsStmt":
        this.checkResourceBody(statement.body, createChildScope(scope, "block"), "atlasPalettedPermutations");
        break;
      case "EquipmentLayerStmt":
        checkEquipmentLayerNameExpression(this.context, statement.layer, scope);
        if (statement.texture) {
          this.checkExpression(statement.texture, scope);
        }
        if (statement.dyeable) {
          this.checkExpression(statement.dyeable, scope);
        }
        if (statement.color) {
          this.checkExpression(statement.color, scope);
        }
        if (statement.usePlayerTexture) {
          this.checkExpression(statement.usePlayerTexture, scope);
        }
        break;
      case "ModelTextureStmt":
        this.checkExpression(statement.value, scope);
        break;
      case "ModelElementStmt":
        if (statement.label) {
          this.checkExpression(statement.label, scope);
        }
        if (statement.from) {
          this.checkExpression(statement.from, scope);
        }
        if (statement.to) {
          this.checkExpression(statement.to, scope);
        }
        statement.properties.forEach(property => this.checkExpression(property.value, scope));
        statement.faces.forEach(face => face.properties.forEach(property => this.checkExpression(property.value, scope)));
        break;
      case "ItemRangeStmt":
        this.checkExpression(statement.property, scope);
        statement.options.forEach(option => this.checkExpression(option.value, scope));
        if (statement.frames) {
          this.checkExpression(statement.frames.frames, scope);
          const frameScope = createChildScope(scope, "block");
          this.context.defineIdentifier(frameScope, syntheticIdentifier("index", statement.frames.range), "variable", numberType, statement.frames);
          this.context.defineIdentifier(frameScope, syntheticIdentifier("frame", statement.frames.range), "variable", anyType, statement.frames);
          this.checkExpression(statement.frames.model, frameScope);
        }
        if (statement.fallback) {
          this.checkExpression(statement.fallback, scope);
        }
        break;
      case "ItemSelectStmt":
        this.checkExpression(statement.property, scope);
        statement.options.forEach(option => this.checkExpression(option.value, scope));
        statement.cases.forEach(item => {
          this.checkExpression(item.when, scope);
          this.checkExpression(item.model, scope);
        });
        if (statement.fallback) {
          this.checkExpression(statement.fallback, scope);
        }
        break;
      case "ItemConditionStmt":
        this.checkExpression(statement.property, scope);
        statement.options.forEach(option => this.checkExpression(option.value, scope));
        if (statement.onTrue) {
          this.checkExpression(statement.onTrue, scope);
        }
        if (statement.onFalse) {
          this.checkExpression(statement.onFalse, scope);
        }
        break;
      case "ItemCompositeStmt":
        statement.models.forEach(model => this.checkExpression(model, scope));
        break;
      case "ItemSpecialStmt":
        this.checkExpression(statement.base, scope);
        this.checkExpression(statement.model, scope);
        break;
      case "ForStmt":
        this.checkForStatement(statement, scope);
        break;
      case "IfStmt":
        this.checkExpression(statement.condition, scope);
        this.checkBody(statement.thenBody, createChildScope(scope, "block"));
        if (statement.elseBody) {
          this.checkBody(statement.elseBody, createChildScope(scope, "block"));
        }
        break;
      case "BaseStmt":
        this.checkExpression(statement.path, scope);
        break;
      case "MergeStmt":
        this.checkExpression(statement.value, scope);
        break;
      case "ExternVarStmt":
      case "ItemEmptyStmt":
      case "ItemSelectedItemStmt":
      case "UnknownStmt":
        break;
      default:
        assertNever(statement);
    }
  }

  private checkForIterableExpression(expression: ExprNode, scope: RsglScope): RsglType {
    if (expression.kind !== "ListExpr") {
      return this.checkExpression(expression, scope);
    }
    const elementTypes = expression.elements.map(element => this.checkForIterableListElement(element, scope));
    return { kind: "List", elementType: elementTypes[0] ?? unknownType };
  }

  private checkForIterableListElement(expression: ExprNode, scope: RsglScope): RsglType {
    if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
      return stringType;
    }
    return this.checkExpression(expression, scope);
  }

  private checkVariantStatements(statements: VariantSectionStatementNode[], scope: RsglScope): void {
    for (const statement of statements) {
      switch (statement.kind) {
        case "VariantEntry":
          this.checkExpression(statement.state, scope);
          this.checkExpression(statement.value, scope);
          break;
        case "LetDecl":
          checkLocalLetDecl(this.context, statement, scope);
          break;
        case "UseDecl":
          this.checkExpression(statement.expression, scope);
          break;
        case "ForStmt":
          this.checkForStatement(statement, scope);
          break;
        case "IfStmt":
          this.checkExpression(statement.condition, scope);
          this.checkBody(statement.thenBody, createChildScope(scope, "block"));
          if (statement.elseBody) {
            this.checkBody(statement.elseBody, createChildScope(scope, "block"));
          }
          break;
        case "UnknownStmt":
          break;
        default:
          assertNever(statement);
      }
    }
  }

  private checkMultipartStatements(statements: MultipartSectionStatementNode[], scope: RsglScope): void {
    for (const statement of statements) {
      switch (statement.kind) {
        case "MultipartEntry":
          if (statement.when) {
            this.checkExpression(statement.when, scope);
          }
          this.checkExpression(statement.apply, scope);
          break;
        case "LetDecl":
          checkLocalLetDecl(this.context, statement, scope);
          break;
        case "UseDecl":
          this.checkExpression(statement.expression, scope);
          break;
        case "ForStmt":
          this.checkForStatement(statement, scope);
          break;
        case "IfStmt":
          this.checkExpression(statement.condition, scope);
          this.checkBody(statement.thenBody, createChildScope(scope, "block"));
          if (statement.elseBody) {
            this.checkBody(statement.elseBody, createChildScope(scope, "block"));
          }
          break;
        case "UnknownStmt":
          break;
        default:
          assertNever(statement);
      }
    }
  }

  private checkExpression(expression: ExprNode, scope: RsglScope): RsglType {
    return checkExpression(this.context, expression, scope);
  }
}

function syntheticIdentifier(text: string, range: { start: number; end: number }): IdentifierNode {
  return {
    kind: "Identifier",
    text,
    range,
    fullRange: range
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled RSGL body node: ${JSON.stringify(value)}`);
}
