import type {
  ExprNode,
  ForStmtNode,
  IdentifierNode,
  ItemCompositeBodyNode,
  ItemFirstMatchBodyNode,
  ItemModelNode,
  ItemModelProducerStmtNode,
  ItemModelTemplateBodyNode,
  ItemOptionNode,
  ItemRangeBodyNode,
  ItemSelectBodyNode,
  ObjectExprNode
} from "../parser";
import type { RsglTemplateCallerContext } from "../templateOutput";
import {
  checkAssignable,
  checkCompileTimeCondition,
  checkExpression,
  checkExpressionForExpectedType,
  checkLocalLetDecl,
  checkTemplateUseExpression
} from "./expressionChecker";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { applyLambdaValueDiagnostics } from "./lambdaAnalysis";
import {
  expectedTypeForResourceReferenceSink,
  type RsglResourceReferenceSinkType
} from "./resourceReferenceSinkTypes";
import { createChildScope } from "./scopes";
import { scopeForTruthyCondition } from "./typeNarrowing";
import {
  anyType,
  numberType,
  type RsglScope,
  type RsglType
} from "./types";

type ItemOwnerBody =
  | ItemSelectBodyNode
  | ItemRangeBodyNode
  | ItemCompositeBodyNode
  | ItemFirstMatchBodyNode
  | ItemModelTemplateBodyNode;

export interface RsglItemModelBodyCheckerHost {
  context: RsglExpressionCheckContext;
  checkForStatement(
    statement: ForStmtNode,
    scope: RsglScope,
    callerContext?: RsglTemplateCallerContext
  ): void;
  checkNestedBody(
    body: ForStmtNode["body"],
    scope: RsglScope,
    callerContext?: RsglTemplateCallerContext
  ): void;
  recordTemplateUse(
    expression: ExprNode,
    scope: RsglScope,
    callerContext?: RsglTemplateCallerContext
  ): void;
}

/**
 * Checks the recursive value language below an item definition's `/model`
 * slot. Resource-root statements stay in RsglResourceBodyChecker; this class
 * owns item-model nodes and their five strongly typed statement bodies.
 */
export class RsglItemModelBodyChecker {
  public constructor(private readonly host: RsglItemModelBodyCheckerHost) { }

  public checkProducer(statement: ItemModelProducerStmtNode, scope: RsglScope): void {
    this.checkNode(statement.value, scope);
  }

  public checkTemplateBody(body: ItemModelTemplateBodyNode, scope: RsglScope): void {
    for (const statement of body.statements) {
      switch (statement.kind) {
        case "ItemModelProducerStmt":
          this.checkProducer(statement, scope);
          break;
        case "LetDecl":
          checkLocalLetDecl(this.host.context, statement, scope);
          break;
        case "UseDecl":
          this.checkUse(statement.expression, scope);
          break;
        case "ForStmt":
          this.host.checkForStatement(statement, scope, itemModelCallerContext);
          break;
        case "IfStmt":
          this.checkIf(statement, scope);
          break;
        case "UnknownStmt":
          break;
        default:
          assertNever(statement);
      }
    }
    applyLambdaValueDiagnostics(this.host.context.diagnostics, body.statements, scope);
  }

  public checkSelectBody(body: ItemSelectBodyNode, scope: RsglScope): void {
    for (const statement of body.statements) {
      switch (statement.kind) {
        case "ItemSelectCase":
          checkExpression(this.host.context, statement.when, scope);
          this.checkNode(statement.model, scope);
          break;
        case "ItemFallbackClause":
          this.checkNode(statement.model, scope);
          break;
        case "LetDecl":
          checkLocalLetDecl(this.host.context, statement, scope);
          break;
        case "ForStmt":
          this.host.checkForStatement(statement, scope, itemModelCallerContext);
          break;
        case "IfStmt":
          this.checkIf(statement, scope);
          break;
        case "UnknownStmt":
          break;
        default:
          assertNever(statement);
      }
    }
    applyLambdaValueDiagnostics(this.host.context.diagnostics, body.statements, scope);
  }

  public checkRangeBody(body: ItemRangeBodyNode, scope: RsglScope): void {
    for (const statement of body.statements) {
      switch (statement.kind) {
        case "ItemRangeEntry":
          this.checkNumberExpression(statement.threshold, scope);
          this.checkNode(statement.model, scope);
          break;
        case "ItemRangeFrames": {
          checkExpression(this.host.context, statement.frames, scope);
          const frameScope = createChildScope(scope, "block");
          this.host.context.defineIdentifier(
            frameScope,
            syntheticIdentifier("index", statement.range),
            "variable",
            numberType,
            statement
          );
          this.host.context.defineIdentifier(
            frameScope,
            syntheticIdentifier("frame", statement.range),
            "variable",
            anyType,
            statement
          );
          this.checkNode(statement.model, frameScope);
          break;
        }
        case "ItemFallbackClause":
          this.checkNode(statement.model, scope);
          break;
        case "LetDecl":
          checkLocalLetDecl(this.host.context, statement, scope);
          break;
        case "ForStmt":
          this.host.checkForStatement(statement, scope, itemModelCallerContext);
          break;
        case "IfStmt":
          this.checkIf(statement, scope);
          break;
        case "UnknownStmt":
          break;
        default:
          assertNever(statement);
      }
    }
    applyLambdaValueDiagnostics(this.host.context.diagnostics, body.statements, scope);
  }

  public checkCompositeBody(body: ItemCompositeBodyNode, scope: RsglScope): void {
    for (const statement of body.statements) {
      switch (statement.kind) {
        case "ItemCompositeModel":
          this.checkNode(statement.model, scope);
          break;
        case "LetDecl":
          checkLocalLetDecl(this.host.context, statement, scope);
          break;
        case "ForStmt":
          this.host.checkForStatement(statement, scope, itemModelCallerContext);
          break;
        case "IfStmt":
          this.checkIf(statement, scope);
          break;
        case "UnknownStmt":
          break;
        default:
          assertNever(statement);
      }
    }
    applyLambdaValueDiagnostics(this.host.context.diagnostics, body.statements, scope);
  }

  public checkFirstMatchBody(body: ItemFirstMatchBodyNode, scope: RsglScope): void {
    for (const statement of body.statements) {
      switch (statement.kind) {
        case "ItemFirstMatchWhen":
          this.checkResourceReference(statement.property, scope, "resource");
          this.checkPropertyOptions(statement.propertyOptions, scope);
          this.checkNode(statement.model, scope);
          break;
        case "ItemFallbackClause":
          this.checkNode(statement.model, scope);
          break;
        case "LetDecl":
          checkLocalLetDecl(this.host.context, statement, scope);
          break;
        case "ForStmt":
          this.host.checkForStatement(statement, scope, itemModelCallerContext);
          break;
        case "IfStmt":
          this.checkIf(statement, scope);
          break;
        case "UnknownStmt":
          break;
        default:
          assertNever(statement);
      }
    }
    applyLambdaValueDiagnostics(this.host.context.diagnostics, body.statements, scope);
  }

  public checkNode(node: ItemModelNode, scope: RsglScope): void {
    switch (node.kind) {
      case "ItemModelExpr":
        this.checkResourceReference(node.expression, scope, "itemModel");
        this.checkOptions(node.options, scope);
        break;
      case "ItemModelUse":
        this.checkUse(node.expression, scope);
        break;
      case "ItemModelSelect":
        this.checkResourceReference(node.property, scope, "resource");
        this.checkPropertyOptions(node.propertyOptions, scope);
        this.checkSelectBody(node.body, createChildScope(scope, "block"));
        this.checkOptions(node.options, scope);
        break;
      case "ItemModelRange":
        this.checkResourceReference(node.property, scope, "resource");
        this.checkPropertyOptions(node.propertyOptions, scope);
        this.checkRangeBody(node.body, createChildScope(scope, "block"));
        this.checkOptions(node.options, scope);
        break;
      case "ItemModelCondition":
        this.checkResourceReference(node.property, scope, "resource");
        this.checkPropertyOptions(node.propertyOptions, scope);
        if (node.onTrue) {
          this.checkNode(node.onTrue, scope);
        }
        if (node.onFalse) {
          this.checkNode(node.onFalse, scope);
        }
        this.checkOptions(node.options, scope);
        break;
      case "ItemModelComposite":
        this.checkCompositeBody(node.body, createChildScope(scope, "block"));
        this.checkOptions(node.options, scope);
        break;
      case "ItemModelFirstMatch":
        this.checkFirstMatchBody(node.body, createChildScope(scope, "block"));
        this.checkOptions(node.options, scope);
        break;
      case "ItemModelSpecial":
        this.checkResourceReference(node.base, scope, "model");
        checkExpression(this.host.context, node.model, scope);
        this.checkOptions(node.options, scope);
        break;
      case "ItemModelEmpty":
      case "ItemModelSelectedItem":
        break;
      default:
        assertNever(node);
    }
  }

  private checkIf(
    statement: Extract<ItemOwnerBody["statements"][number], { kind: "IfStmt" }>,
    scope: RsglScope
  ): void {
    checkCompileTimeCondition(this.host.context, statement.condition, scope);
    const thenScope = scopeForTruthyCondition(scope, statement.condition);
    this.host.checkNestedBody(
      statement.thenBody,
      thenScope === scope ? createChildScope(scope, "block") : thenScope,
      itemModelCallerContext
    );
    if (statement.elseBody) {
      this.host.checkNestedBody(
        statement.elseBody,
        createChildScope(scope, "block"),
        itemModelCallerContext
      );
    }
  }

  private checkUse(expression: ExprNode, scope: RsglScope): void {
    checkTemplateUseExpression(this.host.context, expression, scope);
    this.host.recordTemplateUse(expression, scope, itemModelCallerContext);
  }

  private checkPropertyOptions(options: readonly ItemOptionNode[], scope: RsglScope): void {
    options.forEach(option => checkExpression(this.host.context, option.value, scope));
  }

  private checkOptions(options: ObjectExprNode | undefined, scope: RsglScope): void {
    if (options) {
      checkExpression(this.host.context, options, scope);
    }
  }

  private checkNumberExpression(expression: ExprNode, scope: RsglScope): RsglType {
    const actual = checkExpressionForExpectedType(
      this.host.context,
      expression,
      scope,
      numberType
    );
    checkAssignable(this.host.context, numberType, actual, expression);
    return actual;
  }

  private checkResourceReference(
    expression: ExprNode,
    scope: RsglScope,
    sink: RsglResourceReferenceSinkType
  ): RsglType {
    const expected = expectedTypeForResourceReferenceSink(sink);
    const actual = checkExpressionForExpectedType(this.host.context, expression, scope, expected);
    checkAssignable(this.host.context, expected, actual, expression);
    return actual;
  }
}

const itemModelCallerContext: Extract<RsglTemplateCallerContext, { kind: "itemModel" }> = {
  kind: "itemModel"
};

function syntheticIdentifier(text: string, range: { start: number; end: number }): IdentifierNode {
  return {
    kind: "Identifier",
    text,
    range,
    fullRange: range
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled item-model semantic node: ${JSON.stringify(value)}`);
}
