import {
  ArgumentNode,
  ExprNode,
  ObjectPropertyNode,
  TextRange
} from "../parser";
import { tryParseMinecraftResourceId } from "../../../mc-assets/src";
import { isJsonObject, normalizeJsonValue } from "./compilerHelpers";
import { ExpansionFrame, JsonValue, RsglMapping } from "./ir";
import { expandSequencePattern, formatSequenceNumber, sequencePadWidth } from "./sequences";

export interface LambdaValue {
  kind: "lambda";
  parameters: string[];
  body: ExprNode;
  context: EvaluationContext;
}

export type EvaluationValue = JsonValue | LambdaValue | undefined;
export type RawJsonLoadMode = "auto" | "file";
export type RawJsonLoader = (request: string, context: EvaluationContext, range: TextRange, mode?: RawJsonLoadMode) => EvaluationValue;
export type RawGlobLoader = (pattern: string, context: EvaluationContext, range: TextRange) => string[] | undefined;

export interface EvaluationContext {
  namespace: string;
  variables: Map<string, EvaluationValue>;
  stateKeyAliases?: ReadonlySet<string>;
  sourceFile?: string;
  mappingReason?: RsglMapping["reason"];
  expansionStack?: ExpansionFrame[];
  rawJsonLoader?: RawJsonLoader;
  globLoader?: RawGlobLoader;
  onError?: (code: string, message: string, range: TextRange) => void;
}

const builtinValues = new Map<string, JsonValue>([
  ["HORIZONTAL", ["north", "east", "south", "west"]],
  ["DIRECTIONS", ["down", "up", "north", "south", "west", "east"]],
  ["STAIR_SHAPES", ["straight", "inner_left", "inner_right", "outer_left", "outer_right"]],
  ["COLORS_16", [
    "white",
    "orange",
    "magenta",
    "light_blue",
    "yellow",
    "lime",
    "pink",
    "gray",
    "light_gray",
    "cyan",
    "purple",
    "blue",
    "brown",
    "green",
    "red",
    "black"
  ]]
]);

const horizontalYaw: Record<string, number> = {
  north: 0,
  east: 90,
  south: 180,
  west: 270
};

interface SeqGenerator {
  name: string;
  iterable: ExprNode;
}

export function evaluateExpression(expression: ExprNode, context: EvaluationContext): EvaluationValue {
  if (expression.kind === "StringLiteral") {
    return expression.value;
  }
  if (expression.kind === "NumberLiteral") {
    return expression.value;
  }
  if (expression.kind === "BooleanLiteral") {
    return expression.value;
  }
  if (expression.kind === "NullLiteral") {
    return null;
  }
  if (expression.kind === "ResourceLocationExpr") {
    return expression.value.includes(":") ? expression.value : `${context.namespace}:${expression.value}`;
  }
  if (expression.kind === "IdentifierExpr") {
    if (context.variables.has(expression.name.text)) {
      return context.variables.get(expression.name.text);
    }
    return builtinValues.get(expression.name.text) ?? expression.name.text;
  }
  if (expression.kind === "TemplateStringExpr") {
    return expression.parts.map(part => {
      if (part.kind === "text") {
        return part.text;
      }
      return String(evaluateExpression(part.expression, context) ?? "");
    }).join("");
  }
  if (expression.kind === "ListExpr") {
    return expression.elements.map(element => normalizeJsonValue(evaluateExpression(element, context)));
  }
  if (expression.kind === "ObjectExpr") {
    return evaluateObjectProperties(expression.properties, context);
  }
  if (expression.kind === "StateKeySugar") {
    return evaluateStateKeyProperties(expression.entries, context);
  }
  if (expression.kind === "ModelApplySugar") {
    const model = normalizeModelApplyValue(evaluateExpression(expression.model, context), context.namespace);
    const result: Record<string, JsonValue> = { model };
    for (const property of expression.properties) {
      result[property.name.text] = normalizeJsonValue(evaluateExpression(property.value, context));
    }
    return omitBlockstateModelDefaults(result);
  }
  if (expression.kind === "RandomApply") {
    return expression.entries.map(entry => normalizeJsonValue(evaluateExpression(entry, context)));
  }
  if (expression.kind === "RangeExpr") {
    const start = Number(evaluateExpression(expression.startExpr, context));
    const end = Number(evaluateExpression(expression.endExpr, context));
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return [];
    }
    const values: number[] = [];
    const step = start <= end ? 1 : -1;
    for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
      values.push(value);
    }
    return values;
  }
  if (expression.kind === "ForInExpr") {
    return evaluateExpression(expression.iterable, context);
  }
  if (expression.kind === "CallExpr") {
    if (expression.callee.kind === "IdentifierExpr" && expression.callee.name.text === "seq") {
      return evaluateSeqExpression(expression, context);
    }
    const args = expression.args.map(arg => ({
      name: arg.name?.text,
      value: evaluateExpression(arg.value, context),
      range: arg.value.range
    }));
    const calleeValue = evaluateExpression(expression.callee, context);
    if (isLambdaValue(calleeValue)) {
      return evaluateLambdaCall(calleeValue, expression.args, args, context, expression.range);
    }
    return evaluateCallExpression(expression.callee, args, context, expression.range);
  }
  if (expression.kind === "LambdaExpr") {
    return {
      kind: "lambda",
      parameters: expression.parameters.map(parameter => parameter.text),
      body: expression.body,
      context: captureEvaluationContext(context)
    };
  }
  if (expression.kind === "MemberExpr") {
    const objectValue = evaluateExpression(expression.object, context);
    if (isJsonObject(objectValue)) {
      return objectValue[expression.property.text] as EvaluationValue;
    }
    return undefined;
  }
  if (expression.kind === "IndexExpr") {
    const objectValue = evaluateExpression(expression.object, context);
    const indexValue = evaluateExpression(expression.index, context);
    if (Array.isArray(objectValue) && typeof indexValue === "number") {
      return objectValue[indexValue] as EvaluationValue;
    }
    if (isJsonObject(objectValue)) {
      return objectValue[String(indexValue)] as EvaluationValue;
    }
    return undefined;
  }
  if (expression.kind === "ConditionalExpr") {
    return evaluateExpression(truthy(evaluateExpression(expression.condition, context)) ? expression.whenTrue : expression.whenFalse, context);
  }
  if (expression.kind === "MatchExpr") {
    return evaluateMatchExpression(expression.expression, expression.arms, context);
  }
  if (expression.kind === "BinaryExpr") {
    return evaluateBinaryExpression(expression.operator, evaluateExpression(expression.left, context), evaluateExpression(expression.right, context));
  }
  if (expression.kind === "UnaryExpr") {
    const value = evaluateExpression(expression.operand, context);
    return expression.operator === "!" ? !truthy(value) : -Number(value);
  }
  return undefined;
}

function evaluateSeqExpression(
  expression: Extract<ExprNode, { kind: "CallExpr" }>,
  context: EvaluationContext
): EvaluationValue {
  const patternArg = expression.args.find(arg => arg.name?.text === "pattern")
    ?? expression.args.filter(arg => !arg.name)[0];
  if (!patternArg) {
    return [];
  }

  const padArg = expression.args.find(arg => arg.name?.text === "pad");
  const padWidth = padArg ? sequencePadWidth(evaluateExpression(padArg.value, context)) : null;
  const generatorArgs = expression.args.filter(arg => arg !== patternArg && arg !== padArg);
  const positionalGeneratorArgs = generatorArgs.filter(arg => !arg.name);
  const positionalGenerators = positionalGeneratorArgs
    .map(arg => arg.value)
    .filter((value): value is Extract<ExprNode, { kind: "ForInExpr" }> => value.kind === "ForInExpr")
    .map(value => ({ name: value.binding.text, iterable: value.iterable }));
  const namedGenerators = generatorArgs
    .filter(arg => arg.name)
    .map(arg => ({ name: arg.name!.text, iterable: arg.value }));
  const generators = [...positionalGenerators, ...namedGenerators];
  if (generators.length === 0) {
    return expandSequencePattern(String(evaluateExpression(patternArg.value, context) ?? ""), { pad: padWidth });
  }
  if (positionalGenerators.length !== positionalGeneratorArgs.length) {
    return [];
  }

  return evaluateSeqGeneratorPatterns(patternArg.value, generators, context, 0, [], padWidth);
}

function evaluateSeqGeneratorPatterns(
  pattern: ExprNode,
  generators: SeqGenerator[],
  context: EvaluationContext,
  index: number,
  boundNames: string[],
  padWidth: number | null
): string[] {
  if (index >= generators.length) {
    const value = String(evaluateExpression(pattern, context) ?? "");
    return expandSequencePattern(replaceSeqPlaceholders(value, context, boundNames), { pad: padWidth });
  }

  const generator = generators[index];
  const iterable = evaluateExpression(generator.iterable, context);
  if (!Array.isArray(iterable)) {
    return [];
  }

  const results: string[] = [];
  for (const value of iterable) {
    const name = generator.name;
    const child = childEvaluationContext(context, { [name]: sequenceBindingValue(value, padWidth) });
    results.push(...evaluateSeqGeneratorPatterns(pattern, generators, child, index + 1, [...boundNames, name], padWidth));
  }
  return results;
}

function sequenceBindingValue(value: JsonValue, padWidth: number | null): JsonValue {
  return padWidth !== null && typeof value === "number" && Number.isFinite(value)
    ? formatSequenceNumber(value, padWidth)
    : normalizeJsonValue(value);
}

function replaceSeqPlaceholders(pattern: string, context: EvaluationContext, boundNames: string[]): string {
  let result = pattern;
  for (const name of boundNames) {
    const value = scalarText(context.variables.get(name));
    if (value !== null) {
      result = result.replace(new RegExp(`\\{${escapeRegExp(name)}\\}`, "g"), value);
    }
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function childEvaluationContext(
  context: EvaluationContext,
  values: Record<string, EvaluationValue>,
  metadata: Partial<Pick<EvaluationContext, "sourceFile" | "mappingReason" | "expansionStack" | "onError">> = {}
): EvaluationContext {
  return {
    ...context,
    variables: new Map([...context.variables, ...Object.entries(values)]),
    sourceFile: metadata.sourceFile ?? context.sourceFile,
    mappingReason: metadata.mappingReason ?? context.mappingReason,
    expansionStack: metadata.expansionStack ?? context.expansionStack,
    onError: metadata.onError ?? context.onError
  };
}

function evaluateObjectProperties(properties: ObjectPropertyNode[], context: EvaluationContext): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const property of properties) {
    const key = propertyKeyToString(property, context);
    if (key) {
      result[key] = normalizeJsonValue(evaluateExpression(property.value, context));
    }
  }
  return result;
}

function evaluateStateKeyProperties(properties: ObjectPropertyNode[], context: EvaluationContext): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const property of properties) {
    const key = stateKeyToString(property, context);
    if (key) {
      result[key] = normalizeJsonValue(evaluateExpression(property.value, context));
    }
  }
  return result;
}

function propertyKeyToString(property: ObjectPropertyNode, context: EvaluationContext): string | null {
  if (property.key.kind === "Identifier") {
    return property.key.text;
  }
  if (property.key.kind === "StringLiteral") {
    return property.key.value;
  }
  if (property.key.kind === "NumberLiteral") {
    return property.key.raw;
  }
  const value = evaluateExpression(property.key.expression, context);
  return value === undefined ? null : String(value);
}

function stateKeyToString(property: ObjectPropertyNode, context: EvaluationContext): string | null {
  if (property.key.kind === "Identifier") {
    if (context.stateKeyAliases?.has(property.key.text)) {
      const value = context.variables.get(property.key.text);
      return scalarText(value) ?? property.key.text;
    }
    return property.key.text;
  }
  if (property.key.kind === "StringLiteral") {
    return property.key.value;
  }
  if (property.key.kind === "NumberLiteral") {
    return property.key.raw;
  }
  const value = evaluateExpression(property.key.expression, context);
  return scalarText(value);
}

function normalizeModelApplyValue(value: EvaluationValue, namespace: string): JsonValue {
  const text = scalarText(value);
  if (text === null) {
    return normalizeJsonValue(value);
  }
  return text.includes(":") ? text : `${namespace}:${text}`;
}

function scalarText(value: EvaluationValue): string | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : null;
}

function evaluateBinaryExpression(operator: string, left: EvaluationValue, right: EvaluationValue): EvaluationValue {
  if (operator === "+") {
    return typeof left === "string" || typeof right === "string" ? `${left ?? ""}${right ?? ""}` : Number(left) + Number(right);
  }
  if (operator === "-") {
    return Number(left) - Number(right);
  }
  if (operator === "*") {
    return Number(left) * Number(right);
  }
  if (operator === "/") {
    return Number(left) / Number(right);
  }
  if (operator === "%") {
    return Number(left) % Number(right);
  }
  if (operator === "==") {
    return left === right;
  }
  if (operator === "!=") {
    return left !== right;
  }
  if (operator === "<") {
    return compareValues(left, right) < 0;
  }
  if (operator === "<=") {
    return compareValues(left, right) <= 0;
  }
  if (operator === ">") {
    return compareValues(left, right) > 0;
  }
  if (operator === ">=") {
    return compareValues(left, right) >= 0;
  }
  if (operator === "&&") {
    return truthy(left) && truthy(right);
  }
  if (operator === "||") {
    return truthy(left) || truthy(right);
  }
  return undefined;
}

function evaluateCallExpression(
  callee: ExprNode,
  args: Array<{ name?: string; value: EvaluationValue; range: TextRange }>,
  context: EvaluationContext,
  range: TextRange
): EvaluationValue {
  if (callee.kind !== "IdentifierExpr") {
    return undefined;
  }

  if (callee.name.text === "raw_json" || callee.name.text === "raw_json_file") {
    const request = argumentValue(args, "path", 0);
    const mode: RawJsonLoadMode = callee.name.text === "raw_json_file" ? "file" : "auto";
    return typeof request === "string" ? context.rawJsonLoader?.(request, context, range, mode) : undefined;
  }
  if (callee.name.text === "glob") {
    const pattern = argumentValue(args, "pattern", 0);
    return typeof pattern === "string" ? context.globLoader?.(pattern, context, range) ?? [] : [];
  }
  if (callee.name.text === "product") {
    const source = normalizeJsonValue(argumentValue(args, "source", 0));
    return source && typeof source === "object" && !Array.isArray(source) ? product(source as Record<string, JsonValue>) : [];
  }
  if (callee.name.text === "pad") {
    const value = String(argumentValue(args, "value", 0) ?? "");
    const width = Number(argumentValue(args, "width", 1) ?? 0);
    return value.padStart(width, "0");
  }
  if (callee.name.text === "seq") {
    const pattern = String(argumentValue(args, "pattern", 0) ?? "");
    return expandSequencePattern(pattern);
  }
  if (callee.name.text === "yaw") {
    return horizontalYaw[String(argumentValue(args, "direction", 0))] ?? 0;
  }
  if (callee.name.text === "model_path") {
    return resourceAssetPath(String(argumentValue(args, "id", 0) ?? ""), context.namespace, "models", "json");
  }
  if (callee.name.text === "texture_path") {
    return resourceAssetPath(String(argumentValue(args, "id", 0) ?? ""), context.namespace, "textures", "png");
  }
  if (callee.name.text === "resource_namespace") {
    return parseResourceIdValue(String(argumentValue(args, "id", 0) ?? ""), context.namespace)?.namespace ?? "";
  }
  if (callee.name.text === "resource_path") {
    return parseResourceIdValue(String(argumentValue(args, "id", 0) ?? ""), context.namespace)?.path ?? "";
  }
  if (callee.name.text === "startsWith") {
    return String(argumentValue(args, "str", 0) ?? "").startsWith(String(argumentValue(args, "prefix", 1) ?? ""));
  }
  if (callee.name.text === "endsWith") {
    return String(argumentValue(args, "str", 0) ?? "").endsWith(String(argumentValue(args, "suffix", 1) ?? ""));
  }
  if (callee.name.text === "replace") {
    const source = String(argumentValue(args, "str", 0) ?? "");
    const oldText = String(argumentValue(args, "old", 1) ?? "");
    const newText = String(argumentValue(args, "new", 2) ?? "");
    return oldText ? source.split(oldText).join(newText) : source;
  }
  if (callee.name.text === "padStart") {
    const source = String(argumentValue(args, "str", 0) ?? "");
    const length = Number(argumentValue(args, "len", 1) ?? 0);
    const pad = String(argumentValue(args, "pad", 2) ?? "");
    return source.padStart(length, pad);
  }
  if (callee.name.text === "padEnd") {
    const source = String(argumentValue(args, "str", 0) ?? "");
    const length = Number(argumentValue(args, "len", 1) ?? 0);
    const pad = String(argumentValue(args, "pad", 2) ?? "");
    return source.padEnd(length, pad);
  }

  return undefined;
}

function evaluateLambdaCall(
  lambda: LambdaValue,
  rawArgs: ArgumentNode[],
  args: Array<{ name?: string; value: EvaluationValue; range: TextRange }>,
  callContext: EvaluationContext,
  range: TextRange
): EvaluationValue {
  if (rawArgs.length !== lambda.parameters.length) {
    callContext.onError?.(
      "rsgl.lambdaArityMismatch",
      `Expected ${lambda.parameters.length} lambda argument(s), got ${rawArgs.length}.`,
      range
    );
  }

  const positional = args.filter(arg => !arg.name);
  const values: Record<string, EvaluationValue> = {};
  lambda.parameters.forEach((parameter, index) => {
    values[parameter] = args.find(arg => arg.name === parameter)?.value
      ?? positional[index]?.value;
  });

  return evaluateExpression(lambda.body, childEvaluationContext(lambda.context, values, {
    sourceFile: lambda.context.sourceFile,
    mappingReason: lambda.context.mappingReason,
    expansionStack: lambda.context.expansionStack,
    onError: callContext.onError
  }));
}

function isLambdaValue(value: EvaluationValue): value is LambdaValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { kind?: string }).kind === "lambda");
}

function captureEvaluationContext(context: EvaluationContext): EvaluationContext {
  return {
    ...context,
    variables: new Map(context.variables),
    stateKeyAliases: context.stateKeyAliases ? new Set(context.stateKeyAliases) : undefined
  };
}

function argumentValue(args: Array<{ name?: string; value: EvaluationValue }>, name: string, positionalIndex: number): EvaluationValue {
  return args.find(arg => arg.name === name)?.value
    ?? args.filter(arg => !arg.name)[positionalIndex]?.value;
}

function evaluateMatchExpression(
  expression: ExprNode,
  arms: Array<{ patterns: ExprNode[]; value: ExprNode }>,
  context: EvaluationContext
): EvaluationValue {
  const matchedValue = normalizeJsonValue(evaluateExpression(expression, context));
  for (const arm of arms) {
    if (arm.patterns.some(pattern => matchesPattern(pattern, matchedValue, context))) {
      return evaluateExpression(arm.value, context);
    }
  }
  return undefined;
}

function matchesPattern(pattern: ExprNode, value: JsonValue, context: EvaluationContext): boolean {
  if (pattern.kind === "IdentifierExpr" && pattern.name.text === "_") {
    return true;
  }
  return jsonEquals(normalizeJsonValue(evaluateExpression(pattern, context)), value);
}

function product(source: Record<string, JsonValue>): JsonValue[] {
  const entries = Object.entries(source).map(([key, value]) => ({
    key,
    values: Array.isArray(value) ? value : [value]
  }));
  let results: Record<string, JsonValue>[] = [{}];
  for (const entry of entries) {
    const next: Record<string, JsonValue>[] = [];
    for (const result of results) {
      for (const value of entry.values) {
        next.push({ ...result, [entry.key]: value });
      }
    }
    results = next;
  }
  return results;
}

function compareValues(left: EvaluationValue, right: EvaluationValue): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function resourceAssetPath(value: string, namespace: string, root: string, extension: string): string {
  const id = parseResourceIdValue(value, namespace);
  if (!id) {
    return "";
  }
  return `assets/${id.namespace}/${root}/${id.path}.${extension}`;
}

function parseResourceIdValue(value: string, namespace: string): { namespace: string; path: string } | null {
  return tryParseMinecraftResourceId(value, namespace);
}

function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => jsonEquals(item, right[index]));
  }
  if (isJsonObject(left) || isJsonObject(right)) {
    if (!isJsonObject(left) || !isJsonObject(right)) {
      return false;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every(key => jsonEquals(left[key] as JsonValue, right[key] as JsonValue));
  }
  return false;
}

function truthy(value: EvaluationValue): boolean {
  return Boolean(value);
}

function omitBlockstateModelDefaults(model: Record<string, JsonValue>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(model)) {
    if ((key === "x" || key === "y" || key === "z") && value === 0) {
      continue;
    }
    if (key === "uvlock" && value === false) {
      continue;
    }
    if (key === "weight" && value === 1) {
      continue;
    }
    result[key] = value;
  }
  return result;
}
