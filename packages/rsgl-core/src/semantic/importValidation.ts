import { bindRsglArguments } from "../arguments";
import { ArgumentNode, ExprNode, RsglDiagnostic } from "../parser";
import { walkRsglModule } from "../parser/astTraversal";
import { diagnostic } from "./diagnostics";
import {
  checkExpression,
  checkResourceIdExpression,
  checkTextureRefExpression,
  RsglExpressionCheckContext
} from "./expressionChecker";
import { formatType, isAssignable } from "./typeRelations";
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
  textureIdType,
  textureVariableType,
  unknownType
} from "./types";

export function validateResolvedImportCalls(model: RsglSemanticModel): RsglDiagnostic[] {
  const validator = new ResolvedImportCallValidator(model);
  return validator.validate();
}

class ResolvedImportCallValidator {
  private readonly diagnostics: RsglDiagnostic[] = [];
  /** Lambda arguments already fully checked against the resolved signature; the structural walk skips their bodies. */
  private readonly checkedLambdaArgs = new Set<ExprNode>();
  private readonly checkContext: RsglExpressionCheckContext;

  public constructor(private readonly model: RsglSemanticModel) {
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
    walkRsglModule(this.model.module, {
      enterExpression: expression => this.visitExpression(expression)
    });
    return this.diagnostics;
  }

  private visitExpression(expression: ExprNode): "skipChildren" | void {
    if (expression.kind === "CallExpr") {
      this.validateCallExpression(expression);
    } else if (expression.kind === "LambdaExpr" && this.checkedLambdaArgs.has(expression)) {
      return "skipChildren";
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
    if (!callScope) {
      // The binder records named imports and unresolved calls that may later
      // become bare import-all bindings. No record means a lexical binding
      // shadowed the module-level import at this call site.
      return;
    }
    this.validateImportedArguments(symbol.signature, args, expression.range, callScope);
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
   * Lambda arguments and simple id references use the call-site scope snapshot
   * so captures and local id variables resolve after import linking. Limiting
   * the latter to identifiers and simple interpolations avoids pre-checking an
   * opaque imported call whose descendants the structural walk must validate.
   * Other argument kinds keep structural inference.
   */
  private inferArgumentType(expression: ExprNode, expectedType: RsglType, callScope: RsglScope | undefined): RsglType {
    if (
      (expectedType.kind === "TextureRef" || expectedType.kind === "TextureVariable")
      && isContextualTextureRefExpression(expression)
    ) {
      return checkTextureRefExpression(this.checkContext, expression, callScope ?? this.model.scope);
    }
    if (expression.kind === "LambdaExpr" && callScope) {
      return this.checkLambdaArgument(expression, callScope) ?? inferImportedArgumentType(expression, expectedType);
    }
    if (callScope && isResourceIdLike(expectedType) && isSimpleResourceReference(expression)) {
      if (expectedType.kind === "TextureRef" || expectedType.kind === "TextureVariable") {
        return checkTextureRefExpression(this.checkContext, expression, callScope);
      }
      return checkResourceIdExpression(this.checkContext, expression, callScope);
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

function isSimpleResourceReference(expression: ExprNode): boolean {
  return expression.kind === "IdentifierExpr" || (
    expression.kind === "TemplateStringExpr"
    && expression.parts.every(part => part.kind === "text" || part.expression.kind === "IdentifierExpr")
  );
}

function isContextualTextureRefExpression(expression: ExprNode): boolean {
  return expression.kind === "StringLiteral"
    || expression.kind === "ConditionalExpr"
    || expression.kind === "MatchExpr";
}

function inferImportedArgumentType(expression: ExprNode, expectedType: RsglType): RsglType {
  if (
    (expectedType.kind === "TextureRef" || expectedType.kind === "TextureVariable")
    && expression.kind === "StringLiteral"
  ) {
    return expression.value.startsWith("#") ? textureVariableType : textureIdType;
  }
  if (
    isResourceIdLike(expectedType)
    && (expression.kind === "IdentifierExpr" || expression.kind === "StringLiteral" || expression.kind === "TemplateStringExpr")
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
  return type.kind === "ResourceId"
    || type.kind === "ModelId"
    || type.kind === "TextureId"
    || type.kind === "TextureVariable"
    || type.kind === "TextureRef";
}
