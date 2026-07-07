import {
  ArgumentNode,
  CallExprNode,
  ExprNode,
  IdentifierExprNode,
  IdentifierNode,
  StringLiteralNode,
  UseDeclNode
} from "../parser";
import { isBlockstateTemplateUseName } from "../semantic/blockstateTemplateUse";
import { mergeBlockstateFragment, RsglBlockstateFragment } from "./blockstateFragments";
import { staticText } from "./compilerHelpers";
import { EvaluationContext } from "./evaluate";
import { JsonValue, ResourceUnit, RsglMapping, RsglSourceMap } from "./ir";
import { parseResourceId, resourceOutputPath } from "./resourceIds";
import { RsglCompileContext } from "./templateExpansion";

type BlockstateTemplateUseCall = CallExprNode & { callee: IdentifierExprNode };

export interface BlockstateTemplateUseOptions {
  onError: (code: string, message: string, range: { start: number; end: number }) => void;
}

export interface TopLevelBlockstateTemplateUseOptions extends BlockstateTemplateUseOptions {
  compileBlockstateUse: (useStatement: UseDeclNode, context: RsglCompileContext) => RsglBlockstateFragment;
  blockstateFragmentMappings: (
    fragment: RsglBlockstateFragment,
    sourceRange: { start: number; end: number },
    context: RsglCompileContext,
    multipartOffset: number
  ) => RsglMapping[];
  sourceMap: (
    outputPath: string,
    node: { range: { start: number; end: number } },
    context: RsglCompileContext,
    mappings: RsglMapping[]
  ) => RsglSourceMap;
}

export function compileTopLevelBlockstateTemplateUse(
  expression: ExprNode,
  context: RsglCompileContext,
  options: TopLevelBlockstateTemplateUseOptions
): ResourceUnit | null | undefined {
  const call = blockstateTemplateUseCall(expression);
  if (!call) {
    return undefined;
  }
  const idValue = blockstateTemplateIdValue(call, context);
  if (!idValue) {
    options.onError("rsgl.compileMissingResourceId", `Top-level use of '${call.callee.name.text}' requires a static id argument.`, expression.range);
    return null;
  }
  const id = parseResourceId(idValue, context.namespace);
  if (!id) {
    options.onError("rsgl.compileInvalidResourceId", `Invalid blockstate id '${idValue}'.`, expression.range);
    return null;
  }
  const normalized = normalizedBlockstateTemplateUseStatement(call, context, options);
  if (!normalized) {
    return null;
  }
  const fragment = options.compileBlockstateUse(normalized, context);
  const content: Record<string, JsonValue> = {};
  mergeBlockstateFragment(content, fragment, expression.range, { onError: options.onError });
  const outputPath = resourceOutputPath("blockstate", id);
  return {
    id,
    kind: "blockstate",
    outputPath,
    content,
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: options.sourceMap(outputPath, expression, context, options.blockstateFragmentMappings(fragment, expression.range, context, 0))
  };
}

export function normalizedBlockstateTemplateUseStatement(
  useStatement: UseDeclNode,
  context: EvaluationContext,
  options: BlockstateTemplateUseOptions
): UseDeclNode | null | undefined;
export function normalizedBlockstateTemplateUseStatement(
  call: BlockstateTemplateUseCall,
  context: EvaluationContext,
  options: BlockstateTemplateUseOptions
): UseDeclNode | null | undefined;
export function normalizedBlockstateTemplateUseStatement(
  input: UseDeclNode | BlockstateTemplateUseCall,
  context: EvaluationContext,
  options: BlockstateTemplateUseOptions
): UseDeclNode | null | undefined {
  const call = input.kind === "UseDecl" ? blockstateTemplateUseCall(input.expression) : input;
  if (!call) {
    return undefined;
  }
  const idValue = blockstateTemplateIdValue(call, context);
  if (!idValue) {
    return undefined;
  }
  const defaults = defaultBlockstateTemplateArgs(call, idValue, context, options);
  if (!defaults) {
    return null;
  }
  const namedArgs = new Set(call.args.filter(arg => arg.name).map(arg => arg.name!.text));
  const args = call.args.filter(arg => {
    if (!arg.name) {
      return false;
    }
    return arg.name.text !== "id" && arg.name.text !== "models";
  });
  for (const [name, value] of Object.entries(defaults)) {
    if (!namedArgs.has(name)) {
      args.push(syntheticStringArgument(name, value, call.range));
    }
  }
  const expression: CallExprNode = {
    ...call,
    args
  };
  return {
    kind: "UseDecl",
    keyword: "use",
    expression,
    range: input.range,
    fullRange: input.fullRange
  };
}

function blockstateTemplateUseCall(expression: ExprNode): BlockstateTemplateUseCall | null {
  if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
    return null;
  }
  return isBlockstateTemplateUseName(expression.callee.name.text)
    ? expression as BlockstateTemplateUseCall
    : null;
}

function blockstateTemplateIdValue(call: BlockstateTemplateUseCall, context: EvaluationContext): string | null {
  const namedId = call.args.find(arg => arg.name?.text === "id");
  const positionalId = call.args.length === 1 && !call.args[0].name ? call.args[0] : undefined;
  const arg = namedId ?? positionalId;
  return arg ? staticText(arg.value, context) : null;
}

function defaultBlockstateTemplateArgs(
  call: BlockstateTemplateUseCall,
  idValue: string,
  context: EvaluationContext,
  options: BlockstateTemplateUseOptions
): Record<string, string> | null {
  const id = parseResourceId(idValue, context.namespace);
  if (!id) {
    return null;
  }
  const name = call.callee.name.text;
  if (name === "stairs") {
    return stairsTemplateModels(call, idValue, context) ?? {
      base: `${id.namespace}:block/${id.path}`,
      inner: `${id.namespace}:block/${id.path}_inner`,
      outer: `${id.namespace}:block/${id.path}_outer`
    };
  }
  if (name === "slab") {
    const doubleArg = call.args.find(arg => arg.name?.text === "double");
    if (!doubleArg) {
      options.onError("rsgl.slabMissingDouble", "slab use with an id requires an explicit double model.", call.range);
      return null;
    }
    const doubleModel = staticText(doubleArg.value, context);
    if (!doubleModel) {
      options.onError("rsgl.invalidBuiltinUseArgument", "slab double model must evaluate to a resource id string.", doubleArg.value.range);
      return null;
    }
    return {
      bottom: `${id.namespace}:block/${id.path}`,
      top: `${id.namespace}:block/${id.path}_top`,
      double: doubleModel.includes(":") ? doubleModel : `${context.namespace}:${doubleModel}`
    };
  }
  if (name === "fence") {
    return {
      post: `${id.namespace}:block/${id.path}_post`,
      side: `${id.namespace}:block/${id.path}_side`
    };
  }
  if (name === "wall") {
    return {
      post: `${id.namespace}:block/${id.path}_post`,
      side: `${id.namespace}:block/${id.path}_side`,
      sideTall: `${id.namespace}:block/${id.path}_side_tall`
    };
  }
  return {
    post: `${id.namespace}:block/${id.path}_post`,
    side: `${id.namespace}:block/${id.path}_side`,
    sideAlt: `${id.namespace}:block/${id.path}_side_alt`,
    noSide: `${id.namespace}:block/${id.path}_noside`,
    noSideAlt: `${id.namespace}:block/${id.path}_noside_alt`
  };
}

function stairsTemplateModels(
  call: BlockstateTemplateUseCall,
  idValue: string,
  context: EvaluationContext
): { base: string; inner: string; outer: string } | undefined {
  const models = call.args.find(arg => arg.name?.text === "models")?.value;
  const pattern = models ? staticText(models, context) : null;
  if (!pattern) {
    return undefined;
  }
  const id = parseResourceId(idValue, context.namespace);
  if (!id) {
    return undefined;
  }
  const baseName = id.path;
  return {
    base: pattern.replaceAll("{id}", baseName),
    inner: pattern.replaceAll("{id}", `${baseName}_inner`),
    outer: pattern.replaceAll("{id}", `${baseName}_outer`)
  };
}

function syntheticStringArgument(name: string, value: string, range: { start: number; end: number }): ArgumentNode {
  return {
    kind: "Argument",
    name: syntheticIdentifier(name, range),
    value: syntheticStringLiteral(value, range),
    range,
    fullRange: range
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

function syntheticStringLiteral(value: string, range: { start: number; end: number }): StringLiteralNode {
  return {
    kind: "StringLiteral",
    value,
    raw: JSON.stringify(value),
    range,
    fullRange: range
  };
}
