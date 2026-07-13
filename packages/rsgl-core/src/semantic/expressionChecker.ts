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
  textureIdType,
  textureRefType,
  textureVariableType,
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
  /** Called for known imports and unresolved calls that may become bare import-all bindings. */
  recordImportCallScope?(expression: CallExprNode, scope: RsglScope): void;
  /** Suppresses cascaded undefined-symbol noise for rejected syntax with its own primary diagnostic. */
  isUndefinedSymbolDiagnosticSuppressed?(name: string): boolean;
}

export function checkExpression(context: RsglExpressionCheckContext, expression: ExprNode, scope: RsglScope): RsglType {
  if (expression.kind === "IdentifierExpr") {
    const symbol = lookup(scope, expression.name.text);
    context.references.push({ name: expression.name.text, range: expression.range, symbol });
    if (!symbol) {
      if (!context.isUndefinedSymbolDiagnosticSuppressed?.(expression.name.text)) {
        context.diagnostics.push(diagnostic("rsgl.undefinedSymbol", `Undefined RSGL symbol '${expression.name.text}'.`, expression.range));
      }
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
    if (expression.value.startsWith("#")) {
      context.diagnostics.push(diagnostic(
        "rsgl.textureVariableInvalidContext",
        `Texture variable '${expression.value}' is only valid where TextureRef is expected.`,
        expression.range
      ));
      return textureVariableType;
    }
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

export function checkTemplateUseExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): RsglType {
  if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
    const type = checkExpression(context, expression, scope);
    context.diagnostics.push(diagnostic(
      "rsgl.functionValueCannotUse",
      "use requires a template call or a registered resource-body helper.",
      expression.range
    ));
    return type;
  }
  const type = checkCallExpression(context, expression, scope, true);
  return type;
}

export function checkExpressionForExpectedType(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  expectedType: RsglType
): RsglType {
  if (expectedType.kind === "TextureRef" || expectedType.kind === "TextureVariable") {
    return checkTextureRefExpression(context, expression, scope);
  }
  if (
    expectedType.kind === "ResourceId"
    || expectedType.kind === "ModelId"
    || expectedType.kind === "TextureId"
  ) {
    return checkResourceIdExpression(context, expression, scope);
  }
  return checkExpression(context, expression, scope);
}

export function checkTextureRefExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): RsglType {
  if (expression.kind === "StringLiteral") {
    validateTextureRefExpressionSyntax(context, expression);
    return expression.value.startsWith("#") ? textureVariableType : textureIdType;
  }
  if (expression.kind === "TemplateStringExpr") {
    checkExpression(context, expression, scope);
    return textureRefType;
  }
  if (expression.kind === "ResourceLocationExpr") {
    checkResourceIdExpression(context, expression, scope);
    return textureIdType;
  }
  if (expression.kind === "ConditionalExpr") {
    checkExpression(context, expression.condition, scope);
    return mergeTextureRefBranchTypes([
      checkTextureRefExpression(context, expression.whenTrue, scope),
      checkTextureRefExpression(context, expression.whenFalse, scope)
    ]);
  }
  if (expression.kind === "MatchExpr") {
    checkExpression(context, expression.expression, scope);
    const armTypes = expression.arms.map(arm => {
      arm.patterns
        .filter(pattern => !isWildcardPattern(pattern))
        .forEach(pattern => checkExpression(context, pattern, scope));
      return checkTextureRefExpression(context, arm.value, scope);
    });
    checkMatchExhaustiveness(expression, scope, context.diagnostics);
    return mergeTextureRefBranchTypes(armTypes);
  }
  return checkExpression(context, expression, scope);
}

/** Preserves incompatible result branches instead of widening them to Any. */
function mergeTextureRefBranchTypes(types: readonly RsglType[]): RsglType {
  const options: RsglType[] = [];
  const seen = new Set<string>();
  for (const type of types) {
    const candidates = type.kind === "Union" ? type.options ?? [] : [type];
    for (const candidate of candidates) {
      const key = formatType(candidate);
      if (!seen.has(key)) {
        seen.add(key);
        options.push(candidate);
      }
    }
  }
  if (options.length === 0) {
    return unknownType;
  }
  return options.length === 1 ? options[0] : { kind: "Union", options };
}

/** Runs only the syntax checks that depend on a value being used as TextureRef. */
export function validateTextureRefExpressionSyntax(
  context: Pick<RsglExpressionCheckContext, "diagnostics">,
  expression: ExprNode
): void {
  if (expression.kind !== "StringLiteral") {
    return;
  }
  if (expression.value.startsWith("#")) {
    if (!/^#[A-Za-z0-9_.\-/]+$/.test(expression.value)) {
      context.diagnostics.push(diagnostic(
        "rsgl.invalidTextureVariable",
        `Invalid texture variable '${expression.value}'.`,
        expression.range
      ));
    }
    return;
  }
  validateResourceLocationValue(context, expression.value, expression.range);
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
  const expectedType = typeFromAnnotation(statement.typeAnnotation);
  const actualType = checkExpressionForExpectedType(context, statement.value, scope, expectedType);
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

function checkCallExpression(
  context: RsglExpressionCheckContext,
  expression: CallExprNode,
  scope: RsglScope,
  allowTemplate = false
): RsglType {
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
    if (!symbol || symbol.kind === "import") {
      context.recordImportCallScope?.(expression, scope);
    }
    if (symbol?.kind === "import") {
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

  if (symbol.signature.templateOutput && !allowTemplate) {
    context.diagnostics.push(diagnostic(
      "rsgl.templateRequiresUse",
      `Template '${callee.name.text}' must be invoked with use.`,
      expression.range
    ));
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
  let generatorCount = 0;
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
      generatorCount++;
      continue;
    }
    if (arg.value.kind !== "ForInExpr") {
      context.diagnostics.push(diagnostic("rsgl.invalidSeqGenerator", "seq generator arguments must use 'name in iterable'.", arg.value.range));
      checkExpression(context, arg.value, scope);
      continue;
    }
    checkExpression(context, arg.value.iterable, scope);
    context.defineIdentifier(generatorScope, arg.value.binding, "variable", stringType, arg.value);
    generatorCount++;
  }

  const patternType = checkExpression(context, patternArg.value, scope);
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

function checkArguments(context: RsglExpressionCheckContext, signature: RsglSignature, args: ArgumentNode[], scope: RsglScope, callRange: TextRange): void {
  const binding = bindRsglArguments(signature.parameters, args, { callRange });
  context.diagnostics.push(...binding.diagnostics);
  const checkedArgs = new Set<ArgumentNode>();

  for (const { parameter, arg } of binding.assignments) {
    checkedArgs.add(arg);
    const actualType = checkExpressionForExpectedType(context, arg.value, scope, parameter.type);
    checkAssignable(context, parameter.type, actualType.kind === "Unknown" ? anyType : actualType, arg.value);
  }
  for (const arg of binding.unmatchedArgs) {
    if (!checkedArgs.has(arg)) {
      checkExpression(context, arg.value, scope);
    }
  }
}

function validateResourceLocationValue(
  context: Pick<RsglExpressionCheckContext, "diagnostics">,
  value: string,
  range: TextRange
): void {
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
