import { bindRsglArguments } from "../arguments";
import { callArgumentMessages } from "../diagnosticMessages";
import { ArgumentNode, ExprNode, RsglDiagnostic } from "../parser";
import { walkRsglModule } from "../parser/astTraversal";
import { diagnostic } from "./diagnostics";
import { mergeResolvedExpectedTypeFact } from "./expectedTypeFacts";
import {
  checkAssignable,
  checkExpression,
  checkExpressionForExpectedType
} from "./expressionChecker";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { scopeWithLinkedGlobalFallback } from "./linkedScope";
import { resolveCallableSymbolInScope } from "./moduleNamespace";
import { formatType, isAssignable } from "./typeRelations";
import {
  identifierName,
  RsglReferenceRecord,
  RsglScope,
  RsglSemanticModel,
  RsglSignature,
  RsglType
} from "./types";

export function validateResolvedImportCalls(model: RsglSemanticModel): RsglDiagnostic[] {
  const validator = new ResolvedImportCallValidator(model);
  return validator.validate();
}

class ResolvedImportCallValidator {
  private readonly diagnostics: RsglDiagnostic[] = [];
  /** Argument subtrees already fully checked against a linked signature. */
  private readonly checkedExpressions = new Set<ExprNode>();
  /** References are merged after validation so bare-import first-pass records are not duplicated. */
  private readonly references: RsglReferenceRecord[] = [];
  private readonly checkContext: RsglExpressionCheckContext;

  public constructor(private readonly model: RsglSemanticModel) {
    const resolvedExpectedTypes = model.resolvedExpectedTypes instanceof Map
      ? model.resolvedExpectedTypes
      : new Map(model.resolvedExpectedTypes);
    model.resolvedExpectedTypes = resolvedExpectedTypes;
    this.checkContext = {
      diagnostics: this.diagnostics,
      references: this.references,
      recordResolvedExpectedType: (expression, expectedType) => {
        mergeResolvedExpectedTypeFact(resolvedExpectedTypes, expression, expectedType);
      },
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
    this.mergeReferences();
    const existingDiagnostics = new Set(this.model.diagnostics.map(item =>
      diagnosticSiteKey(item.code, item.range.start, item.range.end)
    ));
    const dedicatedLambdaSites = new Set(this.model.diagnostics
      .filter(item => item.code === "rsgl.invalidLambdaCapture")
      .map(item => rangeSiteKey(item.range.start, item.range.end)));
    return this.diagnostics.filter(item => {
      if (existingDiagnostics.has(diagnosticSiteKey(item.code, item.range.start, item.range.end))) {
        return false;
      }
      return !(
        (item.code === "rsgl.undefinedSymbol" || item.code === "rsgl.notCallable")
        && dedicatedLambdaSites.has(rangeSiteKey(item.range.start, item.range.end))
      );
    });
  }

  private visitExpression(expression: ExprNode): "skipChildren" | void {
    if (this.checkedExpressions.has(expression)) {
      return "skipChildren";
    }
    if (expression.kind === "CallExpr") {
      this.validateCallExpression(expression);
    }
  }

  private validateCallExpression(expression: Extract<ExprNode, { kind: "CallExpr" }>): void {
    const { callee, args } = expression;
    const callScope = this.model.importCallScopes?.get(expression);
    const symbol = callee.kind === "IdentifierExpr"
      ? this.model.scope.symbols.get(callee.name.text)
      : callScope
        ? resolveCallableSymbolInScope(callScope, callee)
        : undefined;
    const isNamedImport = callee.kind === "IdentifierExpr" && symbol?.kind === "import";
    const isNamespaceMember = callee.kind === "MemberExpr" && Boolean(symbol);
    if ((!isNamedImport && !isNamespaceMember) || !symbol) {
      return;
    }
    if (!symbol.signature) {
      if (callScope && symbol.type.kind === "Function") {
        this.validateAnonymousImportedFunction(symbol.type, args, expression.range, callScope);
        return;
      }
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

  private validateAnonymousImportedFunction(
    type: RsglType,
    args: ArgumentNode[],
    callRange: { start: number; end: number },
    callScope: RsglScope
  ): void {
    const linkedCallScope = scopeWithLinkedGlobalFallback(callScope, this.model.scope);
    for (const arg of args) {
      if (arg.name) {
        this.diagnostics.push(diagnostic(
          "rsgl.namedArgumentsRequireSignature",
          callArgumentMessages.namedArgumentsRequireSignature,
          arg.range
        ));
      }
    }
    if (type.parameters && args.length !== type.parameters.length) {
      this.diagnostics.push(diagnostic(
        "rsgl.lambdaArityMismatch",
        `Expected ${type.parameters.length} lambda argument(s), got ${args.length}.`,
        callRange
      ));
    }
    for (const [index, arg] of args.entries()) {
      const expectedType = type.parameters?.[index];
      const diagnosticsBeforeCheck = this.diagnostics.length;
      const actualType = this.checkArgument(arg.value, expectedType, linkedCallScope);
      if (
        expectedType
        && this.diagnostics.length === diagnosticsBeforeCheck
        && !isAssignable(expectedType, actualType)
      ) {
        this.diagnostics.push(diagnostic(
          "rsgl.lambdaArgumentTypeMismatch",
          `Expected lambda argument ${formatType(expectedType)}, got ${formatType(actualType)}.`,
          arg.value.range
        ));
      }
    }
  }

  private validateImportedArguments(
    signature: RsglSignature,
    args: ArgumentNode[],
    callRange: { start: number; end: number },
    callScope: RsglScope
  ): void {
    const binding = bindRsglArguments(signature.parameters, args, { callRange });
    if (signature.valueFunction && args.length !== signature.parameters.length) {
      this.diagnostics.push(...binding.diagnostics.filter(item =>
        item.code !== "rsgl.missingArgument" && item.code !== "rsgl.tooManyArguments"
      ));
      this.diagnostics.push(diagnostic(
        "rsgl.lambdaArityMismatch",
        `Expected ${signature.parameters.length} lambda argument(s), got ${args.length}.`,
        callRange
      ));
    } else {
      this.diagnostics.push(...binding.diagnostics);
    }

    const linkedCallScope = scopeWithLinkedGlobalFallback(callScope, this.model.scope);
    const checkedArgs = new Set<ArgumentNode>();
    for (const { parameter, arg } of binding.assignments) {
      checkedArgs.add(arg);
      const diagnosticsBeforeCheck = this.diagnostics.length;
      const actualType = this.checkArgument(arg.value, parameter.type, linkedCallScope);
      if (
        this.diagnostics.length === diagnosticsBeforeCheck
        && !isAssignable(parameter.type, actualType)
      ) {
        if (signature.valueFunction) {
          this.diagnostics.push(diagnostic(
            "rsgl.lambdaArgumentTypeMismatch",
            `Expected lambda argument ${formatType(parameter.type)}, got ${formatType(actualType)}.`,
            arg.value.range
          ));
        } else {
          checkAssignable(this.checkContext, parameter.type, actualType, arg.value);
        }
      }
    }
    for (const arg of binding.unmatchedArgs) {
      if (!checkedArgs.has(arg)) {
        this.checkArgument(arg.value, undefined, linkedCallScope);
      }
    }
  }

  /**
   * Checks every ordinary expression against the resolved parameter type. The
   * lexical snapshot keeps source-position locals authoritative while the
   * linked global fallback supplies named, bare, and re-exported imports.
   */
  private checkArgument(expression: ExprNode, expectedType: RsglType | undefined, callScope: RsglScope): RsglType {
    this.markChecked(expression);
    return expectedType
      ? checkExpressionForExpectedType(this.checkContext, expression, callScope, expectedType)
      : checkExpression(this.checkContext, expression, callScope);
  }

  private checkLambdaArgument(
    expression: ExprNode,
    callScope: RsglScope,
    expectedType?: RsglType
  ): RsglType | null {
    if (expression.kind !== "LambdaExpr") {
      return null;
    }
    this.markChecked(expression);
    return expectedType
      ? checkExpressionForExpectedType(this.checkContext, expression, callScope, expectedType)
      : checkExpression(this.checkContext, expression, callScope);
  }

  private markChecked(expression: ExprNode): void {
    this.checkedExpressions.add(expression);
  }

  private mergeReferences(): void {
    const existingBySite = new Map(this.model.references.map(reference => [
      referenceSiteKey(reference),
      reference
    ]));
    for (const reference of this.references) {
      const key = referenceSiteKey(reference);
      const existing = existingBySite.get(key);
      if (existing) {
        existing.symbol ??= reference.symbol;
      } else {
        this.model.references.push(reference);
        existingBySite.set(key, reference);
      }
    }
  }
}

function diagnosticSiteKey(code: string, start: number, end: number): string {
  return `${code}:${start}:${end}`;
}

function rangeSiteKey(start: number, end: number): string {
  return `${start}:${end}`;
}

function referenceSiteKey(reference: RsglReferenceRecord): string {
  return `${reference.range.start}:${reference.range.end}:${reference.name}`;
}
