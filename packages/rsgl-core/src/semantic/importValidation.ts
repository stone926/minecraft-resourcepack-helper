import {
  ArgumentNode,
  BlockNode,
  ExprNode,
  MultipartBodyNode,
  MultipartSectionStatementNode,
  ObjectPropertyNode,
  ResourceBodyNode,
  ResourceStatementNode,
  RsglDiagnostic,
  TopLevelStatementNode,
  VariantBodyNode,
  VariantSectionStatementNode
} from "../parser";
import { bindRsglArguments } from "../arguments";
import { checkExpression, RsglExpressionCheckContext } from "./expressionChecker";
import {
  anyType,
  identifierName,
  inferLiteralType,
  jsonType,
  numberType,
  resourceIdType,
  RsglScope,
  RsglSemanticModel,
  RsglSignature,
  RsglType,
  unknownType
} from "./types";
import { formatType, isAssignable } from "./typeRelations";

type ValidatableBody = ResourceBodyNode | BlockNode | VariantBodyNode | MultipartBodyNode;

export function validateResolvedImportCalls(model: RsglSemanticModel): RsglDiagnostic[] {
  const validator = new ResolvedImportCallValidator(model);
  return validator.validate();
}

class ResolvedImportCallValidator {
  private readonly diagnostics: RsglDiagnostic[] = [];
  /** Lambda arguments already fully checked against the resolved signature; the structural walk skips their bodies. */
  private readonly checkedLambdaArgs = new Set<ExprNode>();
  private readonly checkContext: RsglExpressionCheckContext;
  private readonly hasImportAllImports: boolean;

  public constructor(private readonly model: RsglSemanticModel) {
    this.hasImportAllImports = model.imports.some(record => record.importAll);
    this.checkContext = {
      diagnostics: this.diagnostics,
      references: model.references,
      defineIdentifier: (scope, identifier, kind, type, node) => {
        const name = identifierName(identifier);
        if (!name) {
          return;
        }
        const symbol = { name, kind, type, node, range: identifier?.range };
        scope.symbols.set(name, symbol);
        model.symbols.push(symbol);
      }
    };
  }

  public validate(): RsglDiagnostic[] {
    this.model.module.statements.forEach(statement => this.validateTopLevelStatement(statement));
    return this.diagnostics;
  }

  private validateTopLevelStatement(statement: TopLevelStatementNode): void {
    if (statement.kind === "LetDecl") {
      this.validateExpression(statement.value);
    } else if (statement.kind === "TableDecl") {
      this.validateExpression(statement.body);
    } else if (statement.kind === "NamespaceDecl") {
      this.validateExpression(statement.name);
    } else if (statement.kind === "TargetDecl") {
      this.validateExpression(statement.value);
    } else if (statement.kind === "TemplateDecl") {
      statement.parameters.forEach(parameter => {
        if (parameter.defaultValue) {
          this.validateExpression(parameter.defaultValue);
        }
      });
      this.validateBody(statement.body);
    } else if (statement.kind === "ResourceDecl") {
      if (statement.id) {
        this.validateExpression(statement.id);
      }
      if (statement.impl) {
        this.validateExpression(statement.impl);
      }
      this.validateBody(statement.body);
    } else if (statement.kind === "UseDecl") {
      this.validateExpression(statement.expression);
    } else if (statement.kind === "ForStmt") {
      this.validateForStatement(statement);
      this.validateBody(statement.body);
    } else if (statement.kind === "IfStmt") {
      this.validateExpression(statement.condition);
      this.validateBody(statement.thenBody);
      if (statement.elseBody) {
        this.validateBody(statement.elseBody);
      }
    } else if (statement.kind === "OverlayDecl") {
      this.validateExpression(statement.directory);
      if (statement.formatRange) {
        this.validateExpression(statement.formatRange);
      }
      this.validateBody(statement.body);
    }
  }

  private validateResourceStatement(statement: ResourceStatementNode): void {
    if (statement.kind === "PropertyStmt") {
      this.validateExpression(statement.value);
    } else if (statement.kind === "SectionStmt") {
      if (statement.value) {
        this.validateExpression(statement.value);
      }
      if (statement.body) {
        this.validateBody(statement.body);
      }
    } else if (statement.kind === "VariantsSection") {
      this.validateVariantStatements(statement.entries);
    } else if (statement.kind === "MultipartSection") {
      this.validateMultipartStatements(statement.entries);
    } else if (statement.kind === "UseDecl") {
      this.validateExpression(statement.expression);
    } else if (statement.kind === "LetDecl") {
      this.validateExpression(statement.value);
    } else if (statement.kind === "ItemRangeStmt") {
      this.validateExpression(statement.property);
      statement.options.forEach(option => this.validateExpression(option.value));
      if (statement.frames) {
        this.validateExpression(statement.frames.frames);
        this.validateExpression(statement.frames.model);
      }
      if (statement.fallback) {
        this.validateExpression(statement.fallback);
      }
    } else if (statement.kind === "ItemSelectStmt") {
      this.validateExpression(statement.property);
      statement.options.forEach(option => this.validateExpression(option.value));
      statement.cases.forEach(item => {
        this.validateExpression(item.when);
        this.validateExpression(item.model);
      });
      if (statement.fallback) {
        this.validateExpression(statement.fallback);
      }
    } else if (statement.kind === "ItemConditionStmt") {
      this.validateExpression(statement.property);
      statement.options.forEach(option => this.validateExpression(option.value));
      if (statement.onTrue) {
        this.validateExpression(statement.onTrue);
      }
      if (statement.onFalse) {
        this.validateExpression(statement.onFalse);
      }
    } else if (statement.kind === "ItemCompositeStmt") {
      statement.models.forEach(model => this.validateExpression(model));
    } else if (statement.kind === "ItemSpecialStmt") {
      this.validateExpression(statement.base);
      this.validateExpression(statement.model);
    } else if (statement.kind === "ForStmt") {
      this.validateForStatement(statement);
      this.validateBody(statement.body);
    } else if (statement.kind === "IfStmt") {
      this.validateExpression(statement.condition);
      this.validateBody(statement.thenBody);
      if (statement.elseBody) {
        this.validateBody(statement.elseBody);
      }
    } else if (statement.kind === "BaseStmt") {
      this.validateExpression(statement.path);
    } else if (statement.kind === "MergeStmt") {
      this.validateExpression(statement.value);
    } else if (statement.kind === "PackFormatsStmt") {
      if (statement.min) {
        this.validateExpression(statement.min);
      }
      if (statement.max) {
        this.validateExpression(statement.max);
      }
    } else if (statement.kind === "PackOverlayStmt") {
      this.validateExpression(statement.directory);
      this.validateBody(statement.body);
    } else if (statement.kind === "PackFilterBlockStmt") {
      if (statement.namespace) {
        this.validateExpression(statement.namespace);
      }
      if (statement.path) {
        this.validateExpression(statement.path);
      }
    } else if (statement.kind === "AtlasDirectoryStmt") {
      if (statement.source) {
        this.validateExpression(statement.source);
      }
      if (statement.prefix) {
        this.validateExpression(statement.prefix);
      }
    } else if (statement.kind === "AtlasFilterStmt") {
      if (statement.namespace) {
        this.validateExpression(statement.namespace);
      }
      if (statement.path) {
        this.validateExpression(statement.path);
      }
    } else if (statement.kind === "AtlasPalettedPermutationsStmt") {
      this.validateBody(statement.body);
    } else if (statement.kind === "EquipmentLayerStmt") {
      this.validateExpression(statement.layer);
      if (statement.texture) {
        this.validateExpression(statement.texture);
      }
      if (statement.dyeable) {
        this.validateExpression(statement.dyeable);
      }
      if (statement.color) {
        this.validateExpression(statement.color);
      }
      if (statement.usePlayerTexture) {
        this.validateExpression(statement.usePlayerTexture);
      }
    }
  }

  private validateBody(body: ValidatableBody): void {
    if (body.kind === "Block") {
      body.statements.forEach(statement => this.validateTopLevelStatement(statement));
    } else if (body.kind === "ResourceBody") {
      body.statements.forEach(statement => this.validateResourceStatement(statement));
    } else if (body.kind === "VariantBody") {
      this.validateVariantBody(body);
    } else {
      this.validateMultipartBody(body);
    }
  }

  private validateVariantBody(body: VariantBodyNode): void {
    this.validateVariantStatements(body.statements);
  }

  private validateVariantStatements(statements: VariantSectionStatementNode[]): void {
    statements.forEach(statement => this.validateVariantStatement(statement));
  }

  private validateVariantStatement(statement: VariantSectionStatementNode): void {
    if (statement.kind === "VariantEntry") {
      this.validateExpression(statement.state);
      this.validateExpression(statement.value);
    } else if (statement.kind === "LetDecl") {
      this.validateExpression(statement.value);
    } else if (statement.kind === "UseDecl") {
      this.validateExpression(statement.expression);
    } else if (statement.kind === "ForStmt") {
      this.validateForStatement(statement);
      this.validateBody(statement.body);
    } else if (statement.kind === "IfStmt") {
      this.validateExpression(statement.condition);
      this.validateBody(statement.thenBody);
      if (statement.elseBody) {
        this.validateBody(statement.elseBody);
      }
    }
  }

  private validateMultipartBody(body: MultipartBodyNode): void {
    this.validateMultipartStatements(body.statements);
  }

  private validateMultipartStatements(statements: MultipartSectionStatementNode[]): void {
    statements.forEach(statement => this.validateMultipartStatement(statement));
  }

  private validateMultipartStatement(statement: MultipartSectionStatementNode): void {
    if (statement.kind === "MultipartEntry") {
      if (statement.when) {
        this.validateExpression(statement.when);
      }
      this.validateExpression(statement.apply);
    } else if (statement.kind === "LetDecl") {
      this.validateExpression(statement.value);
    } else if (statement.kind === "UseDecl") {
      this.validateExpression(statement.expression);
    } else if (statement.kind === "ForStmt") {
      this.validateForStatement(statement);
      this.validateBody(statement.body);
    } else if (statement.kind === "IfStmt") {
      this.validateExpression(statement.condition);
      this.validateBody(statement.thenBody);
      if (statement.elseBody) {
        this.validateBody(statement.elseBody);
      }
    }
  }

  private validateExpression(expression: ExprNode): void {
    if (expression.kind === "CallExpr") {
      this.validateCallExpression(expression);
      this.validateExpression(expression.callee);
      expression.args.forEach(arg => this.validateExpression(arg.value));
    } else if (expression.kind === "LambdaExpr") {
      if (!this.checkedLambdaArgs.has(expression)) {
        this.validateExpression(expression.body);
      }
    } else if (expression.kind === "ListExpr") {
      expression.elements.forEach(element => this.validateExpression(element));
    } else if (expression.kind === "ObjectExpr") {
      expression.properties.forEach(property => this.validateObjectProperty(property));
    } else if (expression.kind === "StateKeySugar") {
      expression.entries.forEach(property => this.validateObjectProperty(property));
    } else if (expression.kind === "ModelApplySugar") {
      this.validateExpression(expression.model);
      expression.properties.forEach(property => this.validateExpression(property.value));
    } else if (expression.kind === "RandomApply") {
      expression.entries.forEach(entry => this.validateExpression(entry));
    } else if (expression.kind === "RangeExpr") {
      this.validateExpression(expression.startExpr);
      this.validateExpression(expression.endExpr);
    } else if (expression.kind === "MemberExpr") {
      this.validateExpression(expression.object);
    } else if (expression.kind === "IndexExpr") {
      this.validateExpression(expression.object);
      this.validateExpression(expression.index);
    } else if (expression.kind === "UnaryExpr") {
      this.validateExpression(expression.operand);
    } else if (expression.kind === "BinaryExpr") {
      this.validateExpression(expression.left);
      this.validateExpression(expression.right);
    } else if (expression.kind === "ConditionalExpr") {
      this.validateExpression(expression.condition);
      this.validateExpression(expression.whenTrue);
      this.validateExpression(expression.whenFalse);
    } else if (expression.kind === "MatchExpr") {
      this.validateExpression(expression.expression);
      expression.arms.forEach(arm => {
        arm.patterns.forEach(pattern => this.validateExpression(pattern));
        this.validateExpression(arm.value);
      });
    } else if (expression.kind === "TemplateStringExpr") {
      expression.parts.forEach(part => {
        if (part.kind === "expression") {
          this.validateExpression(part.expression);
        }
      });
    }
  }

  private validateCallExpression(expression: Extract<ExprNode, { kind: "CallExpr" }>): void {
    const { callee, args } = expression;
    if (callee.kind !== "IdentifierExpr") {
      return;
    }
    const symbol = this.model.scope.symbols.get(callee.name.text);
    if (symbol?.kind !== "import") {
      return;
    }
    const callScope = this.model.importCallScopes?.get(expression);
    if (!symbol.signature) {
      // Imported values (e.g. let-bound lambdas) carry no signature, but lambda
      // arguments still deserve body checking when the binder confirmed the
      // callee resolved to the import.
      if (callScope) {
        for (const arg of args) {
          this.checkLambdaArgument(arg.value, callScope);
        }
      }
      return;
    }
    if (!callScope && !this.hasImportAllImports) {
      // The binder records a scope for every call it resolved to an import.
      // No record without an import-all form means the name was shadowed by a
      // local binding at the call site — the import's signature does not apply.
      return;
    }
    this.validateImportedArguments(symbol.signature, args, expression.range, callScope);
  }

  private validateForStatement(statement: Extract<TopLevelStatementNode | ResourceStatementNode | VariantSectionStatementNode | MultipartSectionStatementNode, { kind: "ForStmt" }>): void {
    const dimensions = statement.dimensions.length
      ? statement.dimensions
      : [{ iterable: statement.iterable }];
    dimensions.forEach(dimension => this.validateExpression(dimension.iterable));
  }

  private validateObjectProperty(property: ObjectPropertyNode): void {
    if (property.key.kind === "DynamicKey") {
      this.validateExpression(property.key.expression);
    }
    this.validateExpression(property.value);
  }

  private validateImportedArguments(
    signature: RsglSignature,
    args: ArgumentNode[],
    callRange: { start: number; end: number },
    callScope: RsglScope | undefined
  ): void {
    const binding = bindRsglArguments(signature.parameters, args, { callRange });
    this.diagnostics.push(...binding.diagnostics);

    for (const { parameter, arg } of binding.assignments) {
      const actualType = this.inferArgumentType(arg.value, parameter.type, callScope);
      if (!isAssignable(parameter.type, actualType)) {
        this.diagnostics.push(diagnostic(
          "rsgl.typeMismatch",
          `Expected ${formatType(parameter.type)}, got ${formatType(actualType)}.`,
          arg.value.range
        ));
      }
    }
  }

  /**
   * Lambda arguments get the full expression check (parameter scoping, body
   * resolution, purity) against the scope snapshot the binder recorded at the
   * call site, so captures of loop variables, template parameters, and local
   * lets resolve. Without a recorded scope (import-all form) the binder
   * already checked the arguments at bind time; everything else keeps the
   * shallow structural inference that tolerates bare identifiers in id-like
   * positions.
   */
  private inferArgumentType(expression: ExprNode, expectedType: RsglType, callScope: RsglScope | undefined): RsglType {
    if (expression.kind === "LambdaExpr" && callScope) {
      return this.checkLambdaArgument(expression, callScope) ?? inferImportedArgumentType(expression, expectedType);
    }
    return inferImportedArgumentType(expression, expectedType);
  }

  private checkLambdaArgument(expression: ExprNode, callScope: RsglScope): RsglType | null {
    if (expression.kind !== "LambdaExpr") {
      return null;
    }
    this.checkedLambdaArgs.add(expression);
    return checkExpression(this.checkContext, expression, callScope);
  }
}

function inferImportedArgumentType(expression: ExprNode, expectedType: RsglType): RsglType {
  if (
    isResourceIdLike(expectedType) &&
    (expression.kind === "IdentifierExpr" || expression.kind === "StringLiteral" || expression.kind === "TemplateStringExpr")
  ) {
    return resourceIdType;
  }
  if (expression.kind === "ObjectExpr" || expression.kind === "StateKeySugar" || expression.kind === "ModelApplySugar" || expression.kind === "RandomApply") {
    return jsonType;
  }
  if (expression.kind === "ListExpr") {
    return { kind: "List", elementType: expression.elements[0] ? inferImportedArgumentType(expression.elements[0], anyType) : unknownType };
  }
  if (expression.kind === "RangeExpr") {
    return { kind: "Range", elementType: numberType };
  }
  const literalType = inferLiteralType(expression);
  return literalType.kind === "Unknown" ? anyType : literalType;
}

function isResourceIdLike(type: RsglType): boolean {
  return type.kind === "ResourceId" || type.kind === "ModelId" || type.kind === "TextureId";
}

function diagnostic(code: string, message: string, range: { start: number; end: number }, severity: RsglDiagnostic["severity"] = "error"): RsglDiagnostic {
  return { code, message, range, severity };
}
