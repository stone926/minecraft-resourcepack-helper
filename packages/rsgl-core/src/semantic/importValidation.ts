import { bindRsglArguments } from "../arguments";
import { ArgumentNode, ExprNode, RsglDiagnostic } from "../parser";
import { walkRsglModule } from "../parser/astTraversal";
import { diagnostic } from "./diagnostics";
import { checkExpression, RsglExpressionCheckContext } from "./expressionChecker";
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
    if (!callScope && !this.hasImportAllImports) {
      // The binder records a scope for every call it resolved to an import.
      // No record without an import-all form means the name was shadowed by a
      // local binding at the call site — the import's signature does not apply.
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
  return type.kind === "ResourceId" || type.kind === "ModelId" || type.kind === "TextureId";
}
