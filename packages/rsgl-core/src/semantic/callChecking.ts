import { callArgumentMessages } from "../diagnosticMessages";
import {
  ArgumentNode,
  CallExprNode,
  ExprNode,
  ObjectExprNode,
  RsglNode,
  TextRange
} from "../parser";
import { bindRsglArguments } from "../arguments";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import {
  checkCollectionBuiltinCall,
  isCollectionBuiltinName
} from "./collectionBuiltinInference";
import { diagnostic } from "./diagnostics";
import { checkModuleNamespaceMember } from "./moduleNamespace";
import { inferProductType, RsglProductSourceIssue } from "./productTypeInference";
import { createChildScope, lookup } from "./scopes";
import { formatType, isAssignable } from "./typeRelations";
import { inferredUnionBudgetOptions } from "./unionBudget";
import {
  anyType,
  numberType,
  RsglScope,
  RsglSignature,
  RsglType,
  stringType,
  unknownType
} from "./types";

export interface RsglCallCheckHost {
  checkExpression(
    context: RsglExpressionCheckContext,
    expression: ExprNode,
    scope: RsglScope
  ): RsglType;
  checkExpressionForExpectedType(
    context: RsglExpressionCheckContext,
    expression: ExprNode,
    scope: RsglScope,
    expectedType: RsglType
  ): RsglType;
  checkAssignable(
    context: RsglExpressionCheckContext,
    expected: RsglType,
    actual: RsglType,
    node: RsglNode
  ): void;
  checkContextualObjectExpression(
    context: RsglExpressionCheckContext,
    expression: ObjectExprNode,
    scope: RsglScope,
    expectedType: RsglType
  ): RsglType;
}

export function checkCallExpression(
  context: RsglExpressionCheckContext,
  expression: CallExprNode,
  scope: RsglScope,
  host: RsglCallCheckHost,
  allowTemplate = false,
  expectedReturnType?: RsglType
): RsglType {
  const { callee, args } = expression;
  if (callee.kind === "MemberExpr" && callee.object.kind === "IdentifierExpr") {
    const receiver = lookup(scope, callee.object.name.text);
    if (receiver?.type.kind === "ModuleNamespace") {
      const objectType = host.checkExpression(context, callee.object, scope);
      const access = checkModuleNamespaceMember(
        context,
        callee,
        objectType,
        allowTemplate ? "template" : "value"
      );
      context.recordImportCallScope?.(expression, scope);
      const member = access?.member;
      if (!member) {
        args.forEach(arg => host.checkExpression(context, arg.value, scope));
        return unknownType;
      }
      const symbol = member.symbol;
      if (!symbol.signature) {
        if (symbol.type.kind === "Function") {
          checkFunctionCallArguments(context, symbol.type, args, scope, expression.range, host);
          return symbol.type.returnType ?? anyType;
        }
        args.forEach(arg => host.checkExpression(context, arg.value, scope));
        context.diagnostics.push(diagnostic(
          "rsgl.notCallable",
          `Imported member '${callee.property.text}' is not callable.`,
          callee.property.range
        ));
        return symbol.type;
      }
      checkArguments(context, symbol.signature, args, scope, expression.range, host);
      return symbol.signature.returnType;
    }
  }
  const calleeType = host.checkExpression(context, callee, scope);

  if (callee.kind !== "IdentifierExpr") {
    if (calleeType.kind === "Function") {
      checkFunctionCallArguments(context, calleeType, args, scope, expression.range, host);
      return calleeType.returnType ?? anyType;
    }
    for (const arg of args) {
      host.checkExpression(context, arg.value, scope);
    }
    return unknownType;
  }

  const symbol = lookup(scope, callee.name.text);
  if (callee.name.text === "seq") {
    return checkSeqCallExpression(context, expression, scope, host);
  }
  if (!symbol?.signature) {
    if (!symbol || symbol.kind === "import") {
      context.recordImportCallScope?.(expression, scope);
    }
    if (symbol?.kind === "import") {
      return anyType;
    }
    if (symbol?.type.kind === "Function") {
      checkFunctionCallArguments(context, symbol.type, args, scope, expression.range, host);
      return symbol.type.returnType ?? anyType;
    }
    for (const arg of args) {
      host.checkExpression(context, arg.value, scope);
    }
    if (symbol) {
      context.diagnostics.push(diagnostic(
        "rsgl.notCallable",
        `RSGL symbol '${callee.name.text}' is not callable.`,
        callee.range
      ));
    }
    return symbol?.type ?? unknownType;
  }

  if (symbol.signature.templateOutput && !allowTemplate) {
    context.diagnostics.push(diagnostic(
      "rsgl.templateRequiresUse",
      `Template '${callee.name.text}' must be invoked with use.`,
      expression.range
    ));
  }

  if (symbol.kind === "builtin" && isCollectionBuiltinName(callee.name.text)) {
    return checkCollectionBuiltinCall(
      context,
      expression,
      scope,
      symbol.signature,
      host,
      expectedReturnType
    );
  }

  const argumentTypes = checkArguments(context, symbol.signature, args, scope, expression.range, host);
  if (symbol.kind === "builtin" && callee.name.text === "product") {
    const sourceType = argumentTypes.get("source");
    if (!sourceType) {
      return symbol.signature.returnType;
    }
    const product = inferProductType(
      sourceType,
      inferredUnionBudgetOptions(context.diagnostics, expression.range)
    );
    reportProductSourceIssues(context, product.issues, expression);
    return product.type;
  }
  return symbol.signature.returnType;
}

function checkFunctionCallArguments(
  context: RsglExpressionCheckContext,
  type: RsglType,
  args: ArgumentNode[],
  scope: RsglScope,
  callRange: TextRange,
  host: RsglCallCheckHost
): void {
  for (const arg of args) {
    if (arg.name) {
      context.diagnostics.push(diagnostic(
        "rsgl.namedArgumentsRequireSignature",
        callArgumentMessages.namedArgumentsRequireSignature,
        arg.range
      ));
    }
  }
  if (!type.parameters) {
    args.forEach(arg => host.checkExpression(context, arg.value, scope));
    return;
  }
  if (args.length !== type.parameters.length) {
    context.diagnostics.push(diagnostic(
      "rsgl.lambdaArityMismatch",
      `Expected ${type.parameters.length} lambda argument(s), got ${args.length}.`,
      callRange
    ));
  }
  for (const [index, arg] of args.entries()) {
    const expectedType = type.parameters[index];
    if (!expectedType) {
      host.checkExpression(context, arg.value, scope);
      continue;
    }
    const diagnosticStart = context.diagnostics.length;
    const actualType = host.checkExpressionForExpectedType(context, arg.value, scope, expectedType);
    if (!isAssignable(expectedType, actualType) && context.diagnostics.length === diagnosticStart) {
      context.diagnostics.push(diagnostic(
        "rsgl.lambdaArgumentTypeMismatch",
        `Expected lambda argument ${formatType(expectedType)}, got ${formatType(actualType)}.`,
        arg.value.range
      ));
    }
  }
}

function checkSeqCallExpression(
  context: RsglExpressionCheckContext,
  expression: CallExprNode,
  scope: RsglScope,
  host: RsglCallCheckHost
): RsglType {
  const positionalArgs = expression.args.filter(arg => !arg.name);
  const patternArg = expression.args.find(arg => arg.name?.text === "pattern") ?? positionalArgs[0];
  const padArg = expression.args.find(arg => arg.name?.text === "pad");
  if (!patternArg) {
    context.diagnostics.push(diagnostic("rsgl.missingArgument", "Missing argument 'pattern'.", expression.range));
    return { kind: "List", elementType: stringType };
  }

  const generatorScope = createChildScope(scope, "block");
  let generatorCount = 0;
  for (const arg of expression.args) {
    if (arg === patternArg) {
      continue;
    }
    if (arg.name) {
      if (arg === padArg) {
        const actualType = host.checkExpression(context, arg.value, scope);
        host.checkAssignable(context, numberType, actualType.kind === "Unknown" ? anyType : actualType, arg.value);
        continue;
      }
      if (arg.name.text === "pattern") {
        host.checkExpression(context, arg.value, scope);
        continue;
      }
      host.checkExpression(context, arg.value, scope);
      context.defineIdentifier(generatorScope, arg.name, "variable", stringType, arg);
      generatorCount++;
      continue;
    }
    if (arg.value.kind !== "ForInExpr") {
      context.diagnostics.push(diagnostic("rsgl.invalidSeqGenerator", "seq generator arguments must use 'name in iterable'.", arg.value.range));
      host.checkExpression(context, arg.value, scope);
      continue;
    }
    host.checkExpression(context, arg.value.iterable, scope);
    context.defineIdentifier(generatorScope, arg.value.binding, "variable", stringType, arg.value);
    generatorCount++;
  }

  const patternType = host.checkExpression(context, patternArg.value, scope);
  if (generatorCount > 0 && patternType.kind !== "Function") {
    context.diagnostics.push(diagnostic(
      "rsgl.invalidSeqPattern",
      "seq generator form requires a lambda pattern.",
      patternArg.value.range
    ));
  }
  checkSeqLambdaPattern(context, patternType, generatorCount, patternArg.value);
  return { kind: "List", elementType: stringType };
}

function checkSeqLambdaPattern(
  context: RsglExpressionCheckContext,
  patternType: RsglType,
  generatorCount: number,
  pattern: ExprNode
): void {
  if (patternType.kind !== "Function" || !patternType.parameters || patternType.parameters.length === generatorCount) {
    return;
  }
  context.diagnostics.push(diagnostic(
    "rsgl.lambdaArityMismatch",
    `Expected ${patternType.parameters.length} lambda argument(s), got ${generatorCount}.`,
    pattern.range
  ));
}

function checkArguments(
  context: RsglExpressionCheckContext,
  signature: RsglSignature,
  args: ArgumentNode[],
  scope: RsglScope,
  callRange: TextRange,
  host: RsglCallCheckHost
): Map<string, RsglType> {
  const binding = bindRsglArguments(signature.parameters, args, { callRange });
  if (signature.valueFunction && args.length !== signature.parameters.length) {
    context.diagnostics.push(...binding.diagnostics.filter(item =>
      item.code !== "rsgl.missingArgument" && item.code !== "rsgl.tooManyArguments"
    ));
    context.diagnostics.push(diagnostic(
      "rsgl.lambdaArityMismatch",
      `Expected ${signature.parameters.length} lambda argument(s), got ${args.length}.`,
      callRange
    ));
  } else {
    context.diagnostics.push(...binding.diagnostics);
  }
  const checkedArgs = new Set<ArgumentNode>();
  const argumentTypes = new Map<string, RsglType>();

  for (const { parameter, arg, duplicate } of binding.assignments) {
    checkedArgs.add(arg);
    const diagnosticStart = context.diagnostics.length;
    const actualType = host.checkExpressionForExpectedType(context, arg.value, scope, parameter.type);
    if (!duplicate && !argumentTypes.has(parameter.name)) {
      argumentTypes.set(parameter.name, actualType);
    }
    const comparableType = actualType.kind === "Unknown" ? anyType : actualType;
    if (!isAssignable(parameter.type, comparableType) && context.diagnostics.length === diagnosticStart) {
      if (signature.valueFunction) {
        context.diagnostics.push(diagnostic(
          "rsgl.lambdaArgumentTypeMismatch",
          `Expected lambda argument ${formatType(parameter.type)}, got ${formatType(comparableType)}.`,
          arg.value.range
        ));
      } else {
        host.checkAssignable(context, parameter.type, comparableType, arg.value);
      }
    }
  }
  for (const arg of binding.unmatchedArgs) {
    if (!checkedArgs.has(arg)) {
      host.checkExpression(context, arg.value, scope);
    }
  }
  return argumentTypes;
}

function reportProductSourceIssues(
  context: RsglExpressionCheckContext,
  issues: readonly RsglProductSourceIssue[],
  expression: CallExprNode
): void {
  for (const issue of issues) {
    const subject = issue.propertyName
      ? `Product dimension '${issue.propertyName}'`
      : "Product source";
    context.diagnostics.push(diagnostic(
      "rsgl.productSourceNotIterable",
      `${subject} must be a List or Range, got ${formatType(issue.actualType)}.`,
      issue.declarationRange ?? expression.range
    ));
  }
}
