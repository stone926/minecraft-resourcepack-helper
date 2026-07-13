import type {
  BlockstateApplyValueNode,
  BlockstateMultipartEntryNode,
  BlockstateMultipartRootBodyNode,
  BlockstateMultipartRootStatementNode,
  BlockstateVariantsRootBodyNode,
  BlockstateVariantsRootStatementNode,
  ExprNode,
  ForStmtNode,
  LegacyBlockstateRootBodyNode,
  LegacyBlockstateRootStatementNode,
  MultipartEntryNode,
  MultipartSectionStatementNode,
  RsglNode,
  VariantEntryNode,
  VariantSectionStatementNode
} from "../parser";
import type { RsglTemplateCallerContext } from "../templateOutput";
import { staticBlockstateRootFields } from "../blockstateModeEvidence";
import { checkBlockstateApplyValue, type RsglBlockstateApplyFactRecorder } from "./blockstateApplyChecker";
import {
  checkBlockstateCondition,
  checkBlockstateSelector
} from "./blockstateSelectorChecker";
import { diagnostic } from "./diagnostics";
import { applyLambdaValueDiagnostics } from "./lambdaAnalysis";
import {
  checkExpression,
  checkLocalLetDecl,
  checkTemplateUseExpression,
  type RsglExpressionCheckContext
} from "./expressionChecker";
import { createChildScope } from "./scopes";
import { scopeForTruthyCondition } from "./typeNarrowing";
import type { RsglScope } from "./types";

type CheckableBlockstateRootBody =
  | BlockstateVariantsRootBodyNode
  | BlockstateMultipartRootBodyNode
  | LegacyBlockstateRootBodyNode;

type CheckableBlockstateRootStatement =
  | BlockstateVariantsRootStatementNode
  | BlockstateMultipartRootStatementNode
  | LegacyBlockstateRootStatementNode;

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
  recordApplyFact: RsglBlockstateApplyFactRecorder;
  recordContextualExpression(
    record: import("./types").RsglBlockstateContextualExpression,
    scope: RsglScope
  ): void;
}

/** Owns blockstate-specific statement semantics; the generic body checker delegates here. */
export class RsglBlockstateBodyChecker {
  public constructor(private readonly host: RsglBlockstateBodyCheckerHost) { }

  public checkRootBody(
    body: CheckableBlockstateRootBody,
    scope: RsglScope,
    callerContext: Extract<RsglTemplateCallerContext, { kind: "blockstateRoot" }>
  ): void {
    for (const statement of body.statements) {
      this.checkRootStatement(statement, scope, callerContext);
    }
    applyLambdaValueDiagnostics(this.host.context.diagnostics, body.statements, scope);
  }

  public checkVariantStatements(
    statements: readonly VariantSectionStatementNode[],
    scope: RsglScope
  ): void {
    for (const statement of statements) {
      switch (statement.kind) {
        case "BlockstateVariantEntry":
          this.checkSelector(statement.selector, statement.selectorSyntax, scope);
          this.checkApplyValue(statement.value, scope);
          break;
        case "VariantEntry":
          this.checkLegacyVariantEntry(statement, scope);
          break;
        case "LetDecl":
          checkLocalLetDecl(this.host.context, statement, scope);
          break;
        case "UseDecl":
          this.checkUse(statement.expression, scope, variantsEntriesCallerContext);
          break;
        case "ForStmt":
          this.host.checkForStatement(statement, scope, variantsEntriesCallerContext);
          break;
        case "IfStmt":
          this.checkIf(statement, scope, variantsEntriesCallerContext);
          break;
        case "UnknownStmt":
          break;
        default:
          assertNever(statement);
      }
    }
    applyLambdaValueDiagnostics(this.host.context.diagnostics, statements, scope);
  }

  public checkMultipartStatements(
    statements: readonly MultipartSectionStatementNode[],
    scope: RsglScope
  ): void {
    for (const statement of statements) {
      switch (statement.kind) {
        case "BlockstateMultipartEntry":
          this.checkCanonicalMultipartEntry(statement, scope);
          break;
        case "MultipartEntry":
          this.checkLegacyMultipartEntry(statement, scope);
          break;
        case "LetDecl":
          checkLocalLetDecl(this.host.context, statement, scope);
          break;
        case "UseDecl":
          this.checkUse(statement.expression, scope, multipartEntriesCallerContext);
          break;
        case "ForStmt":
          this.host.checkForStatement(statement, scope, multipartEntriesCallerContext);
          break;
        case "IfStmt":
          this.checkIf(statement, scope, multipartEntriesCallerContext);
          break;
        case "UnknownStmt":
          break;
        default:
          assertNever(statement);
      }
    }
    applyLambdaValueDiagnostics(this.host.context.diagnostics, statements, scope);
  }

  private checkRootStatement(
    statement: CheckableBlockstateRootStatement,
    scope: RsglScope,
    callerContext: Extract<RsglTemplateCallerContext, { kind: "blockstateRoot" }>
  ): void {
    switch (statement.kind) {
      case "BlockstateVariantEntry":
        this.checkDirectEntryMode("variants", callerContext, statement);
        this.checkSelector(statement.selector, statement.selectorSyntax, scope);
        this.checkApplyValue(statement.value, scope);
        break;
      case "VariantEntry":
        this.checkDirectEntryMode("variants", callerContext, statement);
        this.checkLegacyVariantEntry(statement, scope);
        break;
      case "BlockstateMultipartEntry":
        this.checkDirectEntryMode("multipart", callerContext, statement);
        this.checkCanonicalMultipartEntry(statement, scope);
        break;
      case "MultipartEntry":
        this.checkDirectEntryMode("multipart", callerContext, statement);
        this.checkLegacyMultipartEntry(statement, scope);
        break;
      case "VariantsSection":
        this.checkDirectEntryMode("variants", callerContext, statement);
        this.checkVariantStatements(statement.entries, scope);
        break;
      case "MultipartSection":
        this.checkDirectEntryMode("multipart", callerContext, statement);
        this.checkMultipartStatements(statement.entries, scope);
        break;
      case "LetDecl":
        checkLocalLetDecl(this.host.context, statement, scope);
        break;
      case "UseDecl":
        this.checkUse(statement.expression, scope, callerContext);
        break;
      case "ForStmt":
        this.host.checkForStatement(statement, scope, nestedRootContext(callerContext));
        break;
      case "IfStmt":
        this.checkIf(statement, scope, nestedRootContext(callerContext));
        break;
      case "BaseStmt":
        checkExpression(this.host.context, statement.path, scope);
        break;
      case "MergeStmt":
        checkExpression(this.host.context, statement.value, scope);
        this.checkStaticModeEvidence(statement.value, callerContext);
        break;
      case "PropertyStmt":
        checkExpression(this.host.context, statement.value, scope);
        this.checkNamedRootField(statement.name.text, statement.name.range, callerContext);
        break;
      case "UnknownStmt":
        break;
      default:
        assertNever(statement);
    }
  }

  private checkCanonicalMultipartEntry(statement: BlockstateMultipartEntryNode, scope: RsglScope): void {
    if (statement.when) {
      this.checkCondition(statement.when, scope);
    }
    this.checkApplyValue(statement.apply, scope);
  }

  private checkLegacyVariantEntry(statement: VariantEntryNode, scope: RsglScope): void {
    if (statement.state.kind === "ObjectExpr") {
      this.checkSelector(statement.state, "inlineObject", scope);
    } else {
      checkExpression(this.host.context, statement.state, scope);
    }
    checkExpression(this.host.context, statement.value, scope);
  }

  private checkLegacyMultipartEntry(statement: MultipartEntryNode, scope: RsglScope): void {
    if (statement.when) {
      this.checkCondition(statement.when, scope);
    }
    checkExpression(this.host.context, statement.apply, scope);
  }

  private checkApplyValue(value: BlockstateApplyValueNode, scope: RsglScope): void {
    checkBlockstateApplyValue(
      this.host.context,
      value,
      scope,
      this.host.recordApplyFact
    );
  }

  private checkSelector(
    expression: ExprNode,
    selectorSyntax: "inlineObject" | "parenthesizedExpression",
    scope: RsglScope
  ): void {
    checkBlockstateSelector(this.host.context, expression, selectorSyntax, scope);
    this.host.recordContextualExpression({
      kind: "selector",
      expression,
      selectorSyntax
    }, scope);
  }

  private checkCondition(expression: ExprNode, scope: RsglScope): void {
    checkBlockstateCondition(this.host.context, expression, scope);
    this.host.recordContextualExpression({ kind: "condition", expression }, scope);
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
    statement: Extract<CheckableBlockstateRootStatement | VariantSectionStatementNode | MultipartSectionStatementNode, { kind: "IfStmt" }>,
    scope: RsglScope,
    callerContext: RsglTemplateCallerContext
  ): void {
    checkExpression(this.host.context, statement.condition, scope);
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

  private checkDirectEntryMode(
    producedMode: "variants" | "multipart",
    callerContext: Extract<RsglTemplateCallerContext, { kind: "blockstateRoot" }>,
    node: RsglNode
  ): void {
    if (callerContext.mode !== "neutral" && callerContext.mode !== producedMode) {
      this.host.context.diagnostics.push(diagnostic(
        "rsgl.blockstateModeConflict",
        `A ${callerContext.mode} blockstate cannot contain ${producedMode} entries.`,
        blockstateModeEvidenceRange(node)
      ));
    }
  }

  private checkStaticModeEvidence(
    expression: ExprNode,
    callerContext: Extract<RsglTemplateCallerContext, { kind: "blockstateRoot" }>
  ): void {
    if (expression.kind !== "ObjectExpr") {
      return;
    }
    const fields = staticBlockstateRootFields(expression);
    if (callerContext.mode === "neutral") {
      if (fields.has("variants") && fields.has("multipart")) {
        this.host.context.diagnostics.push(diagnostic(
          "rsgl.blockstateModeConflict",
          "A blockstate root merge cannot contain both variants and multipart.",
          expression.range
        ));
      }
      return;
    }
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
    if (callerContext.mode === "neutral") {
      return;
    }
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

function blockstateModeEvidenceRange(node: RsglNode): { start: number; end: number } {
  if (node.kind === "VariantsSection" || node.kind === "MultipartSection") {
    const keyword = node.kind === "VariantsSection" ? "variants" : "multipart";
    return { start: node.range.start, end: node.range.start + keyword.length };
  }
  return node.range;
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

function nestedRootContext(
  context: Extract<RsglTemplateCallerContext, { kind: "blockstateRoot" }>
): Extract<RsglTemplateCallerContext, { kind: "blockstateRoot" }> {
  return { ...context, allowBase: false };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled blockstate semantic node: ${JSON.stringify(value)}`);
}
