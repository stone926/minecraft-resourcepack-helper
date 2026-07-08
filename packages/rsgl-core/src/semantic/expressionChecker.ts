import { parseMinecraftResourceId } from "../../../mc-assets/src";
import {
  ArgumentNode,
  CallExprNode,
  ExprNode,
  IdentifierNode,
  LetDeclNode,
  ObjectExprNode,
  ObjectPropertyNode,
  RsglDiagnostic,
  RsglNode,
  TextRange
} from "../parser";
import { bindRsglArguments } from "../arguments";
import { diagnostic } from "./diagnostics";
import { checkMatchExhaustiveness, finiteStringDomain, isWildcardPattern } from "./domainChecks";
import { findLambdaImpureCalls, lambdaImpureCallMessage } from "./lambdaPurity";
import { createChildScope, lookup } from "./scopes";
import { formatType, isAssignable } from "./typeRelations";
import {
  anyType,
  booleanType,
  identifierName,
  inferLiteralType,
  jsonType,
  numberType,
  resourceIdType,
  RsglReferenceRecord,
  RsglScope,
  RsglSignature,
  RsglSymbol,
  RsglType,
  stringType,
  typeFromAnnotation,
  unknownType
} from "./types";

export interface RsglExpressionCheckContext {
  readonly diagnostics: RsglDiagnostic[];
  readonly references: RsglReferenceRecord[];
  defineIdentifier(
    scope: RsglScope,
    identifier: IdentifierNode | null | undefined,
    kind: RsglSymbol["kind"],
    type: RsglType,
    node: RsglNode
  ): void;
  /** Called for imported-template calls whose arguments are skipped at bind time. */
  recordImportCallScope?(expression: CallExprNode, scope: RsglScope): void;
}

export function checkExpression(context: RsglExpressionCheckContext, expression: ExprNode, scope: RsglScope): RsglType {
  if (expression.kind === "IdentifierExpr") {
    const symbol = lookup(scope, expression.name.text);
    context.references.push({ name: expression.name.text, range: expression.range, symbol });
    if (!symbol) {
      context.diagnostics.push(diagnostic("rsgl.undefinedSymbol", `Undefined RSGL symbol '${expression.name.text}'.`, expression.range));
      return unknownType;
    }
    return symbol.type;
  }
  if (expression.kind === "ResourceLocationExpr") {
    validateResourceLocationValue(context, expression.value, expression.range);
    return resourceIdType;
  }
  if (expression.kind === "ListExpr") {
    const elementTypes = expression.elements.map(element => checkExpression(context, element, scope));
    return { kind: "List", elementType: elementTypes[0] ?? unknownType };
  }
  if (expression.kind === "ObjectExpr") {
    return checkObject(context, expression, scope);
  }
  if (expression.kind === "StateKeySugar") {
    for (const entry of expression.entries) {
      if (entry.key.kind === "DynamicKey") {
        checkExpression(context, entry.key.expression, scope);
      }
      checkStateKeyValueExpression(context, entry.value, scope);
    }
    return jsonType;
  }
  if (expression.kind === "ModelApplySugar") {
    checkResourceIdExpression(context, expression.model, scope);
    for (const property of expression.properties) {
      checkExpression(context, property.value, scope);
    }
    return jsonType;
  }
  if (expression.kind === "RandomApply") {
    for (const entry of expression.entries) {
      checkExpression(context, entry, scope);
    }
    return jsonType;
  }
  if (expression.kind === "CallExpr") {
    return checkCallExpression(context, expression, scope);
  }
  if (expression.kind === "LambdaExpr") {
    const lambdaScope = createChildScope(scope, "lambda");
    const seen = new Set<string>();
    for (const parameter of expression.parameters) {
      if (seen.has(parameter.text)) {
        context.diagnostics.push(diagnostic("rsgl.duplicateParameter", `Duplicate lambda parameter '${parameter.text}'.`, parameter.range));
      }
      seen.add(parameter.text);
      context.defineIdentifier(lambdaScope, parameter, "parameter", anyType, parameter);
    }
    const returnType = checkExpression(context, expression.body, lambdaScope);
    checkLambdaPurity(context, expression.body);
    return {
      kind: "Function",
      parameters: expression.parameters.map(() => anyType),
      returnType
    };
  }
  if (expression.kind === "ForInExpr") {
    context.diagnostics.push(diagnostic("rsgl.invalidForInExpression", "'name in iterable' generator expressions are only valid as seq arguments.", expression.range));
    checkExpression(context, expression.iterable, scope);
    return unknownType;
  }
  if (expression.kind === "MemberExpr") {
    checkExpression(context, expression.object, scope);
    return anyType;
  }
  if (expression.kind === "IndexExpr") {
    checkExpression(context, expression.object, scope);
    checkExpression(context, expression.index, scope);
    return anyType;
  }
  if (expression.kind === "UnaryExpr") {
    checkExpression(context, expression.operand, scope);
    return expression.operator === "!" ? booleanType : numberType;
  }
  if (expression.kind === "BinaryExpr") {
    checkExpression(context, expression.left, scope);
    checkExpression(context, expression.right, scope);
    return expression.operator === "&&" || expression.operator === "||" || expression.operator.includes("=") ? booleanType : numberType;
  }
  if (expression.kind === "RangeExpr") {
    const startType = checkExpression(context, expression.startExpr, scope);
    const endType = checkExpression(context, expression.endExpr, scope);
    checkAssignable(context, numberType, startType, expression.startExpr);
    checkAssignable(context, numberType, endType, expression.endExpr);
    return { kind: "Range", elementType: numberType };
  }
  if (expression.kind === "ConditionalExpr") {
    checkExpression(context, expression.condition, scope);
    const trueType = checkExpression(context, expression.whenTrue, scope);
    const falseType = checkExpression(context, expression.whenFalse, scope);
    return isAssignable(trueType, falseType) ? trueType : anyType;
  }
  if (expression.kind === "MatchExpr") {
    checkExpression(context, expression.expression, scope);
    for (const arm of expression.arms) {
      arm.patterns
        .filter(pattern => !isWildcardPattern(pattern))
        .forEach(pattern => checkExpression(context, pattern, scope));
      checkExpression(context, arm.value, scope);
    }
    checkMatchExhaustiveness(expression, scope, context.diagnostics);
    return anyType;
  }
  if (expression.kind === "TemplateStringExpr") {
    for (const part of expression.parts) {
      if (part.kind === "expression") {
        checkExpression(context, part.expression, scope);
      }
    }
    return stringType;
  }
  return inferLiteralType(expression);
}

export function checkResourceIdExpression(context: RsglExpressionCheckContext, expression: ExprNode, scope: RsglScope): RsglType {
  if (expression.kind === "StringLiteral") {
    validateResourceLocationValue(context, expression.value, expression.range);
    return resourceIdType;
  }
  if (expression.kind === "TemplateStringExpr") {
    checkExpression(context, expression, scope);
    return resourceIdType;
  }
  if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
    return resourceIdType;
  }
  return checkExpression(context, expression, scope);
}

export function checkEquipmentLayerListExpression(context: RsglExpressionCheckContext, expression: ExprNode, scope: RsglScope): void {
  if (expression.kind === "ListExpr") {
    expression.elements.forEach(element => checkEquipmentLayerNameExpression(context, element, scope));
    return;
  }
  checkEquipmentLayerNameExpression(context, expression, scope);
}

export function checkEquipmentLayerNameExpression(context: RsglExpressionCheckContext, expression: ExprNode, scope: RsglScope): void {
  if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
    return;
  }
  checkExpression(context, expression, scope);
}

export function checkStringEnumLikeExpression(context: RsglExpressionCheckContext, expression: ExprNode, scope: RsglScope): void {
  if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
    return;
  }
  checkExpression(context, expression, scope);
}

export function checkLocalLetDecl(context: RsglExpressionCheckContext, statement: LetDeclNode, scope: RsglScope): void {
  const actualType = checkExpression(context, statement.value, scope);
  const expectedType = typeFromAnnotation(statement.typeAnnotation);
  checkAssignable(context, expectedType, actualType, statement.value);
  const declaredType = statement.typeAnnotation ? expectedType : actualType;
  context.defineIdentifier(scope, statement.name, "variable", declaredType, statement);
  const name = identifierName(statement.name);
  const symbol = name ? lookup(scope, name) : undefined;
  if (symbol && symbol.node === statement) {
    symbol.finiteDomain = finiteStringDomain(statement.value, scope) ?? undefined;
  }
}

export function checkObject(context: RsglExpressionCheckContext, expression: ObjectExprNode, scope: RsglScope): RsglType {
  const properties = new Map<string, RsglType>();
  for (const property of expression.properties) {
    const key = objectKeyName(property);
    const valueType = checkExpression(context, property.value, scope);
    if (key) {
      properties.set(key, valueType);
    }
    if (property.key.kind === "DynamicKey") {
      checkExpression(context, property.key.expression, scope);
    }
  }
  return { kind: "Object", properties };
}

export function checkAssignable(context: RsglExpressionCheckContext, expected: RsglType, actual: RsglType, node: RsglNode): void {
  if (!isAssignable(expected, actual)) {
    context.diagnostics.push(diagnostic(
      "rsgl.typeMismatch",
      `Expected ${formatType(expected)}, got ${formatType(actual)}.`,
      node.range
    ));
  }
}

export function validateResourceLocationLike(context: RsglExpressionCheckContext, expression: ExprNode): void {
  if (expression.kind === "ResourceLocationExpr") {
    validateResourceLocationValue(context, expression.value, expression.range);
  }
}

function checkStateKeyValueExpression(context: RsglExpressionCheckContext, expression: ExprNode, scope: RsglScope): RsglType {
  if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
    return stringType;
  }
  return checkExpression(context, expression, scope);
}

function checkCallExpression(context: RsglExpressionCheckContext, expression: CallExprNode, scope: RsglScope): RsglType {
  const { callee, args } = expression;
  const calleeType = checkExpression(context, callee, scope);

  if (callee.kind !== "IdentifierExpr") {
    for (const arg of args) {
      checkExpression(context, arg.value, scope);
    }
    if (calleeType.kind === "Function") {
      checkFunctionCallArguments(context, calleeType, args, expression.range);
      return calleeType.returnType ?? anyType;
    }
    return unknownType;
  }

  const symbol = lookup(scope, callee.name.text);
  if (callee.name.text === "seq") {
    return checkSeqCallExpression(context, expression, scope);
  }
  if (!symbol?.signature) {
    if (symbol?.kind === "import") {
      context.recordImportCallScope?.(expression, scope);
      return anyType;
    }
    for (const arg of args) {
      checkExpression(context, arg.value, scope);
    }
    if (symbol?.type.kind === "Function") {
      checkFunctionCallArguments(context, symbol.type, args, expression.range);
      return symbol.type.returnType ?? anyType;
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

  checkArguments(context, symbol.signature, args, scope, expression.range);
  return symbol.signature.returnType;
}

function checkFunctionCallArguments(
  context: RsglExpressionCheckContext,
  type: RsglType,
  args: ArgumentNode[],
  callRange: TextRange
): void {
  if (!type.parameters) {
    return;
  }
  if (args.length !== type.parameters.length) {
    context.diagnostics.push(diagnostic(
      "rsgl.lambdaArityMismatch",
      `Expected ${type.parameters.length} lambda argument(s), got ${args.length}.`,
      callRange
    ));
  }
}

function checkLambdaPurity(context: RsglExpressionCheckContext, expression: ExprNode): void {
  for (const impureCall of findLambdaImpureCalls(expression)) {
    context.diagnostics.push(diagnostic("rsgl.lambdaImpureCall", lambdaImpureCallMessage(impureCall.name), impureCall.range));
  }
}

function checkSeqCallExpression(context: RsglExpressionCheckContext, expression: CallExprNode, scope: RsglScope): RsglType {
  const positionalArgs = expression.args.filter(arg => !arg.name);
  const patternArg = expression.args.find(arg => arg.name?.text === "pattern") ?? positionalArgs[0];
  const padArg = expression.args.find(arg => arg.name?.text === "pad");
  if (!patternArg) {
    context.diagnostics.push(diagnostic("rsgl.missingArgument", "Missing argument 'pattern'.", expression.range));
    return { kind: "List", elementType: stringType };
  }

  const generatorScope = createChildScope(scope, "block");
  for (const arg of expression.args) {
    if (arg === patternArg) {
      continue;
    }
    if (arg.name) {
      if (arg === padArg) {
        const actualType = checkExpression(context, arg.value, scope);
        checkAssignable(context, numberType, actualType.kind === "Unknown" ? anyType : actualType, arg.value);
        continue;
      }
      if (arg.name.text === "pattern") {
        checkExpression(context, arg.value, scope);
        continue;
      }
      checkExpression(context, arg.value, scope);
      context.defineIdentifier(generatorScope, arg.name, "variable", stringType, arg);
      continue;
    }
    if (arg.value.kind !== "ForInExpr") {
      context.diagnostics.push(diagnostic("rsgl.invalidSeqGenerator", "seq generator arguments must use 'name in iterable'.", arg.value.range));
      checkExpression(context, arg.value, scope);
      continue;
    }
    checkExpression(context, arg.value.iterable, scope);
    context.defineIdentifier(generatorScope, arg.value.binding, "variable", stringType, arg.value);
  }

  checkExpression(context, patternArg.value, generatorScope);
  return { kind: "List", elementType: stringType };
}

function checkArguments(context: RsglExpressionCheckContext, signature: RsglSignature, args: ArgumentNode[], scope: RsglScope, callRange: TextRange): void {
  const binding = bindRsglArguments(signature.parameters, args, { callRange });
  context.diagnostics.push(...binding.diagnostics);
  const checkedArgs = new Set<ArgumentNode>();

  for (const { parameter, arg } of binding.assignments) {
    checkedArgs.add(arg);
    const actualType = parameter.type.kind === "ResourceId" || parameter.type.kind === "ModelId" || parameter.type.kind === "TextureId"
      ? checkResourceIdExpression(context, arg.value, scope)
      : checkExpression(context, arg.value, scope);
    checkAssignable(context, parameter.type, actualType.kind === "Unknown" ? anyType : actualType, arg.value);
  }
  for (const arg of binding.unmatchedArgs) {
    if (!checkedArgs.has(arg)) {
      checkExpression(context, arg.value, scope);
    }
  }
}

function validateResourceLocationValue(context: RsglExpressionCheckContext, value: string, range: TextRange): void {
  const parsed = parseMinecraftResourceId(value);
  if (value.includes(":") && !parsed.isValid) {
    context.diagnostics.push(diagnostic("rsgl.invalidResourceLocation", `Invalid resource location '${value}'.`, range));
  } else if (!parsed.isValid) {
    context.diagnostics.push(diagnostic("rsgl.invalidResourcePath", `Invalid resource path '${value}'.`, range));
  }
}

function objectKeyName(property: ObjectPropertyNode): string | null {
  if (property.key.kind === "Identifier") {
    return property.key.text;
  }
  if (property.key.kind === "StringLiteral") {
    return property.key.value;
  }
  if (property.key.kind === "NumberLiteral") {
    return property.key.raw;
  }
  return null;
}
