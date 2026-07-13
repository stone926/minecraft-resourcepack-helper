import {
  BlockNode,
  BlockstateMultipartRootBodyNode,
  BlockstateVariantsRootBodyNode,
  ExprNode,
  ForStmtNode,
  IdentifierNode,
  LegacyBlockstateRootBodyNode,
  MultipartBodyNode,
  ResourceBodyNode,
  ResourceStatementNode,
  TopLevelStatementNode,
  VariantBodyNode
} from "../parser";
import { RsglBlockstateBodyChecker } from "./blockstateBodyChecker";
import type { RsglBlockstateApplyFactRecorder } from "./blockstateApplyChecker";
import { diagnostic } from "./diagnostics";
import { applyLambdaValueDiagnostics } from "./lambdaAnalysis";
import { finiteStringDomain } from "./domainChecks";
import {
  checkEquipmentLayerListExpression,
  checkEquipmentLayerNameExpression,
  checkExpression,
  checkTextureRefExpression,
  checkLocalLetDecl,
  checkStringEnumLikeExpression,
  checkTemplateUseExpression,
  RsglExpressionCheckContext,
  validateResourceLocationLike
} from "./expressionChecker";
import { createChildScope, lookup } from "./scopes";
import { scopeForTruthyCondition } from "./typeNarrowing";
import {
  resolveLoopBindingTypes,
  type StructuralIterationIssue
} from "./structuralTypes";
import { inferListType } from "./typeNormalization";
import { formatType } from "./typeRelations";
import { inferredUnionBudgetOptions } from "./unionBudget";
import {
  anyType,
  numberType,
  type RsglBlockstateContextualExpression,
  RsglScope,
  RsglType,
  stringType,
  unknownType
} from "./types";
import type { RsglTemplateCallerContext } from "../templateOutput";

type CheckableBody =
  | ResourceBodyNode
  | BlockNode
  | VariantBodyNode
  | MultipartBodyNode
  | BlockstateVariantsRootBodyNode
  | BlockstateMultipartRootBodyNode
  | LegacyBlockstateRootBodyNode;

export type RsglBlockStatementChecker = (
  statements: TopLevelStatementNode[],
  scope: RsglScope,
  callerContext?: RsglTemplateCallerContext
) => void;

export type RsglTemplateUseRecorder = (
  expression: ExprNode,
  scope: RsglScope,
  callerContext?: RsglTemplateCallerContext
) => void;

export type RsglContextualTextureSinkRecorder = (
  expression: ExprNode,
  actualType: RsglType,
  scope: RsglScope
) => void;

export type RsglBlockstateContextualExpressionRecorder = (
  record: RsglBlockstateContextualExpression,
  scope: RsglScope
) => void;

/** Checks all scope-sensitive statements nested below a top-level declaration. */
export class RsglResourceBodyChecker {
  private readonly blockstateBodyChecker: RsglBlockstateBodyChecker;

  public constructor(
    private readonly context: RsglExpressionCheckContext,
    private readonly checkBlockStatements: RsglBlockStatementChecker,
    private readonly recordTemplateUse: RsglTemplateUseRecorder,
    private readonly recordContextualTextureSink: RsglContextualTextureSinkRecorder,
    recordBlockstateApplyFact: RsglBlockstateApplyFactRecorder,
    recordBlockstateContextualExpression: RsglBlockstateContextualExpressionRecorder
  ) {
    this.blockstateBodyChecker = new RsglBlockstateBodyChecker({
      context,
      checkForStatement: (statement, scope, callerContext) =>
        this.checkForStatement(statement, scope, callerContext),
      checkNestedBody: (body, scope, callerContext) =>
        this.checkBody(body, scope, callerContext),
      recordTemplateUse,
      recordApplyFact: recordBlockstateApplyFact,
      recordContextualExpression: recordBlockstateContextualExpression
    });
  }

  public checkBody(body: CheckableBody, scope: RsglScope, callerContext?: RsglTemplateCallerContext): void {
    switch (body.kind) {
      case "ResourceBody":
        this.checkResourceBody(body, scope, "resource", callerContext);
        break;
      case "Block":
        this.checkBlockStatements(body.statements, scope, callerContext);
        break;
      case "VariantBody":
        this.blockstateBodyChecker.checkVariantStatements(body.statements, scope);
        break;
      case "MultipartBody":
        this.blockstateBodyChecker.checkMultipartStatements(body.statements, scope);
        break;
      case "BlockstateVariantsRootBody":
      case "BlockstateMultipartRootBody":
      case "LegacyBlockstateRootBody":
        this.blockstateBodyChecker.checkRootBody(
          body,
          scope,
          blockstateRootContext(callerContext)
        );
        break;
      default:
        assertNever(body);
    }
  }

  public checkResourceBody(
    body: ResourceBodyNode,
    scope: RsglScope,
    owner = "resource",
    callerContext?: RsglTemplateCallerContext
  ): void {
    for (const statement of body.statements) {
      this.checkResourceStatement(statement, scope, owner, callerContext);
    }
    applyLambdaValueDiagnostics(this.context.diagnostics, body.statements, scope);
  }

  public checkForStatement(
    statement: ForStmtNode,
    scope: RsglScope,
    callerContext?: RsglTemplateCallerContext
  ): void {
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
      const iterableType = this.checkForIterableExpression(dimension.iterable, loopScope);
      const bindingResult = resolveLoopBindingTypes(
        iterableType,
        dimension.bindings.length,
        inferredUnionBudgetOptions(this.context.diagnostics, dimension.iterable.range)
      );
      this.reportIterationIssues(bindingResult.issues, dimension.iterable);
      const finiteDomain = dimension.bindings.length === 1 ? finiteStringDomain(dimension.iterable, loopScope) : null;
      for (const [bindingIndex, binding] of dimension.bindings.entries()) {
        if (seen.has(binding.text)) {
          this.context.diagnostics.push(diagnostic("rsgl.duplicateLoopBinding", `Duplicate loop binding '${binding.text}'.`, binding.range));
        }
        seen.add(binding.text);
        this.context.defineIdentifier(
          loopScope,
          binding,
          "variable",
          bindingResult.bindingTypes[bindingIndex] ?? unknownType,
          binding
        );
        if (finiteDomain) {
          const symbol = lookup(loopScope, binding.text);
          if (symbol) {
            symbol.finiteDomain = finiteDomain;
          }
        }
      }
    }
    this.checkBody(statement.body, loopScope, callerContext);
  }

  private checkResourceStatement(
    statement: ResourceStatementNode,
    scope: RsglScope,
    owner: string,
    callerContext?: RsglTemplateCallerContext
  ): void {
    switch (statement.kind) {
      case "PropertyStmt":
        if (owner === "equipment" && statement.name.text === "layers") {
          checkEquipmentLayerListExpression(this.context, statement.value, scope);
        } else if (owner === "scaling" && statement.name.text === "type") {
          checkStringEnumLikeExpression(this.context, statement.value, scope);
        } else if (
          owner === "textures"
          && callerContext?.kind === "resourceBody"
          && callerContext.resourceKind === "model"
        ) {
          checkTextureRefExpression(this.context, statement.value, scope);
        } else if (owner === "textures" && !callerContext) {
          const valueType = this.checkExpression(statement.value, scope);
          this.recordContextualTextureSink(statement.value, valueType, scope);
        } else {
          const valueType = this.checkExpression(statement.value, scope);
          this.rejectTextureVariableOutsideModelSink(valueType, statement.value);
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
          this.checkResourceBody(statement.body, createChildScope(scope, "block"), statement.name.text, callerContext);
        }
        break;
      case "VariantsSection":
        this.blockstateBodyChecker.checkVariantStatements(statement.entries, scope);
        break;
      case "MultipartSection":
        this.blockstateBodyChecker.checkMultipartStatements(statement.entries, scope);
        break;
      case "BlockstateVariantEntry":
      case "VariantEntry":
        this.blockstateBodyChecker.checkVariantStatements([statement], scope);
        break;
      case "BlockstateMultipartEntry":
      case "MultipartEntry":
        this.blockstateBodyChecker.checkMultipartStatements([statement], scope);
        break;
      case "UseDecl":
        checkTemplateUseExpression(this.context, statement.expression, scope);
        this.recordTemplateUse(statement.expression, scope, callerContext);
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
        this.checkResourceBody(statement.body, createChildScope(scope, "block"), "packOverlay", callerContext);
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
        this.checkResourceBody(statement.body, createChildScope(scope, "block"), "atlasPalettedPermutations", callerContext);
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
        checkTextureRefExpression(this.context, statement.value, scope);
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
        statement.faces.forEach(face => face.properties.forEach(property => {
          if (property.name.text === "texture") {
            checkTextureRefExpression(this.context, property.value, scope);
          } else {
            this.checkExpression(property.value, scope);
          }
        }));
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
        this.checkForStatement(statement, scope, callerContext);
        break;
      case "IfStmt":
        this.checkExpression(statement.condition, scope);
        {
          const thenScope = scopeForTruthyCondition(scope, statement.condition);
          this.checkBody(
            statement.thenBody,
            thenScope === scope ? createChildScope(scope, "block") : thenScope,
            callerContext
          );
        }
        if (statement.elseBody) {
          this.checkBody(statement.elseBody, createChildScope(scope, "block"), callerContext);
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
    return inferListType(
      elementTypes,
      inferredUnionBudgetOptions(this.context.diagnostics, expression.range)
    );
  }

  private checkForIterableListElement(expression: ExprNode, scope: RsglScope): RsglType {
    if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
      return stringType;
    }
    return this.checkExpression(expression, scope);
  }

  private checkExpression(expression: ExprNode, scope: RsglScope): RsglType {
    return checkExpression(this.context, expression, scope);
  }

  private rejectTextureVariableOutsideModelSink(type: RsglType, expression: ExprNode): void {
    if (type.kind !== "TextureVariable" && type.kind !== "TextureRef") {
      return;
    }
    this.context.diagnostics.push(diagnostic(
      "rsgl.textureVariableInvalidContext",
      "Texture variables are only valid in model texture sinks.",
      expression.range
    ));
  }

  private reportIterationIssues(issues: readonly StructuralIterationIssue[], expression: ExprNode): void {
    for (const issue of issues) {
      if (issue.kind === "notIterable") {
        this.context.diagnostics.push(diagnostic(
          "rsgl.nonIterable",
          `A for-loop input must be a List or Range, got ${formatType(issue.actualType)}.`,
          expression.range
        ));
      } else {
        this.context.diagnostics.push(diagnostic(
          "rsgl.invalidLoopDestructuring",
          `Cannot bind ${issue.bindingCount} loop variables from ${formatType(issue.actualType)}.`,
          expression.range
        ));
      }
    }
  }
}

function blockstateRootContext(
  callerContext: RsglTemplateCallerContext | undefined
): Extract<RsglTemplateCallerContext, { kind: "blockstateRoot" }> {
  return callerContext?.kind === "blockstateRoot"
    ? callerContext
    : {
        kind: "blockstateRoot",
        mode: "neutral",
        allowRootMerge: true,
        allowBase: false
      };
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
