import type {
  BlockstateChoiceBodyNode,
  BlockstateChoiceNode,
  BlockstateChoiceStatementNode,
  BlockstateModelSpecNode,
  BlockstateMultipartEntryNode,
  BlockstateMultipartRootBodyNode,
  BlockstateMultipartRootStatementNode,
  BlockstateVariantsRootBodyNode,
  BlockstateVariantsRootStatementNode,
  ExprNode,
  ForStmtNode,
  IfStmtNode,
  MultipartSectionStatementNode,
  VariantSectionStatementNode
} from "../parser";
import {
  forEachBodyStatement,
  type RsglBodyEntryStatement
} from "../bodyStatementDispatch";
import { staticBlockstateRootFields } from "../blockstateModeEvidence";
import type { RsglTemplateCallerContext } from "../templateOutput";
import {
  checkBlockstateModelSpec,
  checkBlockstateRandomWeight
} from "./blockstateModelSpecChecker";
import { checkBlockstateMultipartCondition } from "./blockstateMultipartConditionChecker";
import { checkBlockstateSelector } from "./blockstateSelectorChecker";
import { diagnostic } from "./diagnostics";
import {
  checkCompileTimeCondition,
  checkExpression,
  checkLocalLetDecl,
  checkTemplateUseExpression
} from "./expressionChecker";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { applyLambdaValueDiagnostics } from "./lambdaAnalysis";
import { checkPropertyKey } from "./propertyKeyChecking";
import { createChildScope } from "./scopes";
import { scopeForTruthyCondition } from "./typeNarrowing";
import type { RsglScope } from "./types";

type CheckableBlockstateRootBody =
  | BlockstateVariantsRootBodyNode
  | BlockstateMultipartRootBodyNode;

type CheckableBlockstateRootStatement =
  | BlockstateVariantsRootStatementNode
  | BlockstateMultipartRootStatementNode;

type CheckableBlockstateStatement =
  | CheckableBlockstateRootStatement
  | VariantSectionStatementNode
  | MultipartSectionStatementNode
  | BlockstateChoiceStatementNode;

export interface RsglBlockstateBodyCheckerHost {
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
  recordModelSpec(modelSpec: BlockstateModelSpecNode, scope: RsglScope): void;
  recordContextualExpression(
    record: import("./types").RsglBlockstateContextualExpression,
    scope: RsglScope
  ): void;
}

/** Owns the three distinct blockstate output domains: case, part, and choice. */
export class RsglBlockstateBodyChecker {
  public constructor(private readonly host: RsglBlockstateBodyCheckerHost) { }

  public checkRootBody(
    body: CheckableBlockstateRootBody,
    scope: RsglScope,
    callerContext: Extract<RsglTemplateCallerContext, { kind: "blockstateRoot" }>
  ): void {
    this.checkBodyStatements<
      CheckableBlockstateRootStatement,
      Extract<RsglTemplateCallerContext, { kind: "blockstateRoot" }>
    >(
      body.statements as readonly CheckableBlockstateRootStatement[],
      scope,
      callerContext,
      (statement, entryScope, entryContext) =>
        this.checkRootEntry(statement, entryScope, entryContext),
      nestedRootContext(callerContext)
    );
  }

  public checkVariantStatements(
    statements: readonly VariantSectionStatementNode[],
    scope: RsglScope
  ): void {
    this.checkBodyStatements(
      statements,
      scope,
      variantsEntriesCallerContext,
      (statement, entryScope) => {
        switch (statement.kind) {
          case "BlockstateVariantEntry":
            if (statement.selector.kind !== "BlockstateWildcardSelector") {
              this.checkSelector(statement.selector, entryScope);
            }
            this.checkChoice(statement.choice, entryScope);
            break;
          case "UseDecl":
            this.checkUse(statement.expression, entryScope, variantsEntriesCallerContext);
            break;
          default:
            assertNever(statement);
        }
      }
    );
  }

  public checkMultipartStatements(
    statements: readonly MultipartSectionStatementNode[],
    scope: RsglScope
  ): void {
    this.checkBodyStatements(
      statements,
      scope,
      multipartEntriesCallerContext,
      (statement, entryScope) => {
        switch (statement.kind) {
          case "BlockstateMultipartEntry":
            this.checkMultipartEntry(statement, entryScope);
            break;
          case "UseDecl":
            this.checkUse(statement.expression, entryScope, multipartEntriesCallerContext);
            break;
          default:
            assertNever(statement);
        }
      }
    );
  }

  public checkChoiceStatements(
    statements: readonly BlockstateChoiceStatementNode[],
    scope: RsglScope
  ): void {
    this.checkBodyStatements(
      statements,
      scope,
      choiceEntriesCallerContext,
      (statement, entryScope) => {
        switch (statement.kind) {
          case "BlockstateRandomOption":
            this.checkModelSpec(statement.model, entryScope);
            if (statement.weight) {
              checkBlockstateRandomWeight(this.host.context, statement.weight, entryScope);
            }
            break;
          case "UseDecl":
            this.checkUse(statement.expression, entryScope, choiceEntriesCallerContext);
            break;
          default:
            assertNever(statement);
        }
      }
    );
  }

  private checkRootEntry(
    statement: RsglBodyEntryStatement<CheckableBlockstateRootStatement>,
    scope: RsglScope,
    callerContext: Extract<RsglTemplateCallerContext, { kind: "blockstateRoot" }>
  ): void {
    switch (statement.kind) {
      case "BlockstateVariantEntry":
        if (statement.selector.kind !== "BlockstateWildcardSelector") {
          this.checkSelector(statement.selector, scope);
        }
        this.checkChoice(statement.choice, scope);
        break;
      case "BlockstateMultipartEntry":
        this.checkMultipartEntry(statement, scope);
        break;
      case "UseDecl":
        this.checkUse(statement.expression, scope, callerContext);
        break;
      case "BaseStmt":
        checkExpression(this.host.context, statement.path, scope);
        break;
      case "MergeStmt":
        checkExpression(this.host.context, statement.value, scope);
        this.checkStaticModeEvidence(statement.value, callerContext);
        break;
      case "PropertyStmt":
        for (const name of checkPropertyKey(
          this.host.context,
          statement.key,
          scope,
          { checkExpression }
        ).names ?? []) {
          this.checkNamedRootField(name, statement.key.range, callerContext);
        }
        checkExpression(this.host.context, statement.value, scope);
        break;
      default:
        assertNever(statement);
    }
  }

  private checkMultipartEntry(
    statement: BlockstateMultipartEntryNode,
    scope: RsglScope
  ): void {
    if (!statement.always && statement.predicate) {
      checkBlockstateMultipartCondition(this.host.context, statement.predicate, scope);
      this.host.recordContextualExpression({
        kind: "multipartCondition",
        expression: statement.predicate
      }, scope);
    }
    this.checkChoice(statement.choice, scope);
  }

  private checkChoice(choice: BlockstateChoiceNode, scope: RsglScope): void {
    if (choice.kind === "BlockstateModelSpec") {
      this.checkModelSpec(choice, scope);
      return;
    }
    this.checkChoiceBody(choice.body, createChildScope(scope, "block"));
  }

  private checkChoiceBody(body: BlockstateChoiceBodyNode, scope: RsglScope): void {
    this.checkChoiceStatements(body.statements, scope);
  }

  private checkModelSpec(modelSpec: BlockstateModelSpecNode, scope: RsglScope): void {
    checkBlockstateModelSpec(this.host.context, modelSpec, scope);
    this.host.recordModelSpec(modelSpec, scope);
  }

  private checkSelector(expression: ExprNode, scope: RsglScope): void {
    checkBlockstateSelector(this.host.context, expression, scope);
    this.host.recordContextualExpression({ kind: "selector", expression }, scope);
  }

  private checkUse(
    expression: ExprNode,
    scope: RsglScope,
    callerContext: RsglTemplateCallerContext
  ): void {
    checkTemplateUseExpression(this.host.context, expression, scope);
    this.host.recordTemplateUse(expression, scope, callerContext);
  }

  private checkIf(
    statement: IfStmtNode,
    scope: RsglScope,
    callerContext: RsglTemplateCallerContext
  ): void {
    checkCompileTimeCondition(this.host.context, statement.condition, scope);
    const thenScope = scopeForTruthyCondition(scope, statement.condition);
    this.host.checkNestedBody(
      statement.thenBody,
      thenScope === scope ? createChildScope(scope, "block") : thenScope,
      callerContext
    );
    if (statement.elseBody) {
      this.host.checkNestedBody(
        statement.elseBody,
        createChildScope(scope, "block"),
        callerContext
      );
    }
  }

  private checkBodyStatements<
    TStatement extends CheckableBlockstateStatement,
    TCallerContext extends RsglTemplateCallerContext
  >(
    statements: readonly TStatement[],
    scope: RsglScope,
    callerContext: TCallerContext,
    onEntry: (
      statement: RsglBodyEntryStatement<TStatement>,
      scope: RsglScope,
      callerContext: TCallerContext
    ) => void,
    controlContext: RsglTemplateCallerContext = callerContext
  ): void {
    const context = { scope, callerContext, controlContext };
    forEachBodyStatement(statements, {
      context,
      onEntry: (statement, current) =>
        onEntry(statement, current.scope, current.callerContext),
      onLet: (statement, current) =>
        checkLocalLetDecl(this.host.context, statement, current.scope),
      onFor: (statement, current) =>
        this.host.checkForStatement(statement, current.scope, current.controlContext),
      onIf: (statement, current) =>
        this.checkIf(statement, current.scope, current.controlContext)
    });
    applyLambdaValueDiagnostics(this.host.context.diagnostics, statements, scope);
  }

  private checkStaticModeEvidence(
    expression: ExprNode,
    callerContext: Extract<RsglTemplateCallerContext, { kind: "blockstateRoot" }>
  ): void {
    if (expression.kind !== "ObjectExpr") {
      return;
    }
    const fields = staticBlockstateRootFields(expression);
    const opposite = callerContext.mode === "variants" ? "multipart" : "variants";
    const oppositeField = fields.get(opposite);
    if (oppositeField) {
      this.host.context.diagnostics.push(diagnostic(
        "rsgl.blockstateModeConflict",
        `A ${callerContext.mode} blockstate merge cannot introduce '${opposite}'.`,
        oppositeField.range
      ));
    }
  }

  private checkNamedRootField(
    name: string,
    range: { start: number; end: number },
    callerContext: Extract<RsglTemplateCallerContext, { kind: "blockstateRoot" }>
  ): void {
    const opposite = callerContext.mode === "variants" ? "multipart" : "variants";
    if (name === opposite) {
      this.host.context.diagnostics.push(diagnostic(
        "rsgl.blockstateModeConflict",
        `A ${callerContext.mode} blockstate cannot declare '${opposite}'.`,
        range
      ));
    }
  }
}

const variantsEntriesCallerContext: RsglTemplateCallerContext = {
  kind: "blockstateEntries",
  mode: "variants",
  allowRootMerge: false,
  allowBase: false
};

const multipartEntriesCallerContext: RsglTemplateCallerContext = {
  kind: "blockstateEntries",
  mode: "multipart",
  allowRootMerge: false,
  allowBase: false
};

const choiceEntriesCallerContext: RsglTemplateCallerContext = {
  kind: "blockstateChoice"
};

function nestedRootContext(
  context: Extract<RsglTemplateCallerContext, { kind: "blockstateRoot" }>
): Extract<RsglTemplateCallerContext, { kind: "blockstateRoot" }> {
  return { ...context, allowBase: false };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled blockstate semantic node: ${JSON.stringify(value)}`);
}
