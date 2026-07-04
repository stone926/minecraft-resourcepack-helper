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
import {
  anyType,
  inferLiteralType,
  jsonType,
  numberType,
  resourceIdType,
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

  public constructor(private readonly model: RsglSemanticModel) { }

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
      this.validateBody(statement.body);
    } else if (statement.kind === "ResourceDecl") {
      if (statement.id) {
        this.validateExpression(statement.id);
      }
      this.validateBody(statement.body);
    } else if (statement.kind === "SugarDecl") {
      this.validateSugarStatement(statement);
    } else if (statement.kind === "UseDecl") {
      this.validateExpression(statement.expression);
    } else if (statement.kind === "ForStmt") {
      this.validateExpression(statement.iterable);
      this.validateBody(statement.body);
    } else if (statement.kind === "IfStmt") {
      this.validateExpression(statement.condition);
      this.validateBody(statement.thenBody);
      if (statement.elseBody) {
        this.validateBody(statement.elseBody);
      }
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
    } else if (statement.kind === "ForStmt") {
      this.validateExpression(statement.iterable);
      this.validateBody(statement.body);
    } else if (statement.kind === "IfStmt") {
      this.validateExpression(statement.condition);
      this.validateBody(statement.thenBody);
      if (statement.elseBody) {
        this.validateBody(statement.elseBody);
      }
    } else if (statement.kind === "RawJsonStmt" || statement.kind === "OverrideStmt" || statement.kind === "AppendStmt") {
      this.validateExpression(statement.value);
    }
  }

  private validateSugarStatement(statement: Extract<TopLevelStatementNode, { kind: "SugarDecl" }>): void {
    if (statement.id) {
      this.validateExpression(statement.id);
    }
    statement.entries.forEach(entry => {
      this.validateExpression(entry.id);
      if (entry.target) {
        this.validateExpression(entry.target);
      }
    });
    statement.options.forEach(option => {
      if (option.value) {
        this.validateExpression(option.value);
      }
    });
    if (statement.body) {
      this.validateBody(statement.body);
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
    } else if (statement.kind === "ForStmt") {
      this.validateExpression(statement.iterable);
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
    } else if (statement.kind === "ForStmt") {
      this.validateExpression(statement.iterable);
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
      this.validateCallExpression(expression.callee, expression.args);
      this.validateExpression(expression.callee);
      expression.args.forEach(arg => this.validateExpression(arg.value));
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

  private validateCallExpression(callee: ExprNode, args: ArgumentNode[]): void {
    if (callee.kind !== "IdentifierExpr") {
      return;
    }
    const symbol = this.model.scope.symbols.get(callee.name.text);
    if (symbol?.kind === "import" && symbol.signature) {
      this.validateImportedArguments(symbol.signature, args);
    }
  }

  private validateObjectProperty(property: ObjectPropertyNode): void {
    if (property.key.kind === "DynamicKey") {
      this.validateExpression(property.key.expression);
    }
    this.validateExpression(property.value);
  }

  private validateImportedArguments(signature: RsglSignature, args: ArgumentNode[]): void {
    const namedArgs = new Map(args.filter(arg => arg.name).map(arg => [arg.name!.text, arg]));
    const positionalArgs = args.filter(arg => !arg.name);

    signature.parameters.forEach((parameter, index) => {
      const arg = namedArgs.get(parameter.name) ?? positionalArgs[index];
      if (!arg) {
        if (!parameter.optional) {
          this.diagnostics.push(diagnostic("rsgl.missingArgument", `Missing argument '${parameter.name}'.`, parameter.node?.range ?? { start: 0, end: 1 }));
        }
        return;
      }
      const actualType = inferImportedArgumentType(arg.value, parameter.type);
      if (!isAssignable(parameter.type, actualType)) {
        this.diagnostics.push(diagnostic(
          "rsgl.typeMismatch",
          `Expected ${formatType(parameter.type)}, got ${formatType(actualType)}.`,
          arg.value.range
        ));
      }
    });
  }
}

function inferImportedArgumentType(expression: ExprNode, expectedType: RsglType): RsglType {
  if (isResourceIdLike(expectedType) && expression.kind === "IdentifierExpr") {
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
