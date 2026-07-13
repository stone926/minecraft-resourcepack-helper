import type {
  BlockstateMode,
  ExprNode,
  ForStmtNode,
  IfStmtNode,
  LetDeclNode,
  MergeMode,
  MergeStmtNode,
  ParameterNode,
  RsglNode,
  RsglToken,
  TemplateDeclNode,
  TextRange,
  TypeNode,
  UseDeclNode
} from "../parser";
import { walkRsglModule } from "../parser/astTraversal";
import {
  findLambdaImpureCalls,
  resolvedBuiltinEffect,
  type LambdaBuiltinEffectResolver
} from "../semantic/lambdaPurity";
import type {
  RsglSemanticModel,
  RsglSymbol,
  RsglTemplateUseRecord
} from "../semantic";
import {
  collectLegacyBlockstateSyntaxEdits,
  containsRange,
  createWrapperReplacement,
  findSourceToken,
  type LegacyBlockstateWrapper
} from "./blockstateSyntaxEdits";
import type { MigrationSymbolResolution } from "./symbolResolution";
import { applyTextEdits } from "./textEdits";
import type { MigrationIssue, TextEdit } from "./types";

/**
 * Source-level operation IR used by the breaking root-template migration.
 *
 * The array order is semantic order. Parameter/default binding deliberately
 * precedes body operations, while control-flow owns nested ordered programs.
 * Wrapper nodes are not retained: their entries are lowered in place with an
 * explicit mode, which is the source fact needed by the effect analysis.
 */
export interface RootTemplateOperationProgram {
  readonly template: TemplateDeclNode;
  readonly operations: readonly RootTemplateMigrationOperation[];
}

export type RootTemplateMigrationOperation =
  | { readonly kind: "ParameterBinding"; readonly parameter: ParameterNode }
  | { readonly kind: "Let"; readonly statement: LetDeclNode }
  | {
      readonly kind: "RootMerge";
      readonly statement: MergeStmtNode;
      readonly mergeMode: MergeMode;
    }
  | {
      readonly kind: "ModeEntry";
      readonly statement: RsglNode;
      readonly mode: BlockstateMode;
    }
  | { readonly kind: "Use"; readonly statement: UseDeclNode }
  | {
      readonly kind: "For";
      readonly statement: ForStmtNode;
      readonly operations: readonly RootTemplateMigrationOperation[];
    }
  | {
      readonly kind: "If";
      readonly statement: IfStmtNode;
      readonly thenOperations: readonly RootTemplateMigrationOperation[];
      readonly elseOperations: readonly RootTemplateMigrationOperation[];
    }
  | { readonly kind: "Unsupported"; readonly statement: RsglNode };

export interface RootTemplateOperationEffects {
  readonly parameterCount: number;
  readonly defaultBindingCount: number;
  readonly letCount: number;
  readonly rootMergeCount: number;
  readonly rootMergeModes: readonly MergeMode[];
  readonly modeEntryCount: number;
  readonly entryModes: readonly BlockstateMode[];
  readonly useCount: number;
  readonly controlFlowCount: number;
  readonly unsupportedCount: number;
  readonly orderedKinds: readonly RootTemplateMigrationOperation["kind"][];
}

export type RootTemplateMigrationStrategy =
  | "entryTemplate"
  | "rootMergeValueHelper"
  | "inlineMixed"
  | "manual";

export interface RootTemplateMigrationAnalysis {
  readonly program: RootTemplateOperationProgram;
  readonly effects: RootTemplateOperationEffects;
  readonly strategy: RootTemplateMigrationStrategy;
  readonly reason?: string;
}

interface RootTemplateCallSite {
  statement: UseDeclNode;
  record: RsglTemplateUseRecord;
}

/** Builds the ordered, non-evaluating migration IR for one legacy template. */
export function createRootTemplateOperationProgram(
  template: TemplateDeclNode
): RootTemplateOperationProgram {
  return {
    template,
    operations: [
      ...template.parameters.map(parameter => ({
        kind: "ParameterBinding" as const,
        parameter
      })),
      ...operationsFromStatements(template.body.statements)
    ]
  };
}

/** Returns the recursively aggregated effects without reordering operations. */
export function analyzeRootTemplateOperationEffects(
  program: RootTemplateOperationProgram
): RootTemplateOperationEffects {
  const accumulator: MutableRootTemplateEffects = {
    parameterCount: 0,
    defaultBindingCount: 0,
    letCount: 0,
    rootMergeCount: 0,
    rootMergeModes: new Set(),
    modeEntryCount: 0,
    entryModes: new Set(),
    useCount: 0,
    controlFlowCount: 0,
    unsupportedCount: 0,
    orderedKinds: []
  };
  collectEffects(program.operations, accumulator);
  return {
    parameterCount: accumulator.parameterCount,
    defaultBindingCount: accumulator.defaultBindingCount,
    letCount: accumulator.letCount,
    rootMergeCount: accumulator.rootMergeCount,
    rootMergeModes: [...accumulator.rootMergeModes],
    modeEntryCount: accumulator.modeEntryCount,
    entryModes: [...accumulator.entryModes],
    useCount: accumulator.useCount,
    controlFlowCount: accumulator.controlFlowCount,
    unsupportedCount: accumulator.unsupportedCount,
    orderedKinds: accumulator.orderedKinds
  };
}

/**
 * Classifies one candidate using only source/semantic facts available in the
 * current module. A manual result is intentional: the edit producer must not
 * guess about defaults, exported/cross-module callers, captures, or effects.
 */
export function analyzeLegacyRootTemplateMigration(
  template: TemplateDeclNode,
  model: RsglSemanticModel
): RootTemplateMigrationAnalysis {
  const program = createRootTemplateOperationProgram(template);
  const effects = analyzeRootTemplateOperationEffects(program);
  const calls = collectCallSites(template, model);

  if (effects.unsupportedCount > 0) {
    return manual(program, effects, "The template contains root operations that have no canonical lowering.");
  }
  if (effects.rootMergeCount === 0 && effects.modeEntryCount > 0) {
    if (effects.entryModes.length !== 1 || effects.useCount > 0) {
      return manual(program, effects, "Entry-only migration requires one proven blockstate mode and no unresolved nested use.");
    }
    return { program, effects, strategy: "entryTemplate" };
  }
  if (isSingleMergeProgram(program, effects)) {
    const helperSafety = valueHelperSafety(template, model, calls);
    return helperSafety
      ? manual(program, effects, helperSafety)
      : { program, effects, strategy: "rootMergeValueHelper" };
  }
  if (effects.rootMergeCount > 0 && effects.modeEntryCount > 0) {
    const inlineSafety = mixedInlineSafety(template, model, effects, calls);
    return inlineSafety
      ? manual(program, effects, inlineSafety)
      : { program, effects, strategy: "inlineMixed" };
  }
  return manual(program, effects, "The root operation sequence cannot be split without changing ordering or effects.");
}

/**
 * Adds proven-safe root-template edits and manual issues to the module-wide
 * blockstate migration. Edits remain protocol/transport independent.
 */
export function collectRootTemplateMigrationChanges(
  sourceText: string,
  model: RsglSemanticModel,
  symbols: MigrationSymbolResolution,
  edits: TextEdit[],
  issues: MigrationIssue[]
): void {
  for (const symbol of model.symbols) {
    if (symbol.kind !== "template" || symbol.node?.kind !== "TemplateDecl") {
      continue;
    }
    const template = symbol.node as TemplateDeclNode;
    if (!isLegacyRootTemplateCandidate(symbol, template)) {
      continue;
    }
    const analysis = analyzeLegacyRootTemplateMigration(template, model);
    const produced = produceRootTemplateEdits(
      sourceText,
      model,
      symbols,
      template,
      analysis
    );
    if (produced.issue) {
      issues.push(produced.issue);
    } else {
      edits.push(...produced.edits);
    }
  }
}

/** Compatibility helper retained for clients that only want diagnostics. */
export function collectManualRootTemplateIssues(
  model: RsglSemanticModel,
  issues: MigrationIssue[]
): void {
  for (const symbol of model.symbols) {
    if (symbol.kind !== "template" || symbol.node?.kind !== "TemplateDecl") {
      continue;
    }
    const template = symbol.node as TemplateDeclNode;
    if (!isLegacyRootTemplateCandidate(symbol, template)) {
      continue;
    }
    const analysis = analyzeLegacyRootTemplateMigration(template, model);
    if (analysis.strategy === "manual") {
      issues.push(manualIssue(template.range, analysis.reason));
    }
  }
}

interface MutableRootTemplateEffects {
  parameterCount: number;
  defaultBindingCount: number;
  letCount: number;
  rootMergeCount: number;
  rootMergeModes: Set<MergeMode>;
  modeEntryCount: number;
  entryModes: Set<BlockstateMode>;
  useCount: number;
  controlFlowCount: number;
  unsupportedCount: number;
  orderedKinds: RootTemplateMigrationOperation["kind"][];
}

function operationsFromStatements(
  statements: readonly RsglNode[],
  wrapperMode?: BlockstateMode
): RootTemplateMigrationOperation[] {
  const operations: RootTemplateMigrationOperation[] = [];
  for (const statement of statements) {
    if (statement.kind === "VariantsSection" || statement.kind === "MultipartSection") {
      const wrapper = statement as LegacyBlockstateWrapper;
      operations.push(...operationsFromStatements(
        wrapper.entries,
        wrapper.kind === "VariantsSection" ? "variants" : "multipart"
      ));
    } else if (statement.kind === "LetDecl") {
      operations.push({ kind: "Let", statement: statement as LetDeclNode });
    } else if (statement.kind === "MergeStmt") {
      const merge = statement as MergeStmtNode;
      operations.push({ kind: "RootMerge", statement: merge, mergeMode: merge.mode });
    } else if (statement.kind === "UseDecl") {
      operations.push({ kind: "Use", statement: statement as UseDeclNode });
    } else if (statement.kind === "ForStmt") {
      const loop = statement as ForStmtNode;
      operations.push({
        kind: "For",
        statement: loop,
        operations: operationsFromStatements(loop.body.statements, wrapperMode)
      });
    } else if (statement.kind === "IfStmt") {
      const conditional = statement as IfStmtNode;
      operations.push({
        kind: "If",
        statement: conditional,
        thenOperations: operationsFromStatements(conditional.thenBody.statements, wrapperMode),
        elseOperations: conditional.elseBody
          ? operationsFromStatements(conditional.elseBody.statements, wrapperMode)
          : []
      });
    } else if (
      statement.kind === "VariantEntry"
      || statement.kind === "BlockstateVariantEntry"
      || statement.kind === "MultipartEntry"
      || statement.kind === "BlockstateMultipartEntry"
    ) {
      const mode = statement.kind === "VariantEntry" || statement.kind === "BlockstateVariantEntry"
        ? "variants"
        : "multipart";
      operations.push({ kind: "ModeEntry", statement, mode: wrapperMode ?? mode });
    } else {
      operations.push({ kind: "Unsupported", statement });
    }
  }
  return operations;
}

function collectEffects(
  operations: readonly RootTemplateMigrationOperation[],
  accumulator: MutableRootTemplateEffects
): void {
  for (const operation of operations) {
    accumulator.orderedKinds.push(operation.kind);
    switch (operation.kind) {
      case "ParameterBinding":
        accumulator.parameterCount++;
        accumulator.defaultBindingCount += operation.parameter.defaultValue ? 1 : 0;
        break;
      case "Let":
        accumulator.letCount++;
        break;
      case "RootMerge":
        accumulator.rootMergeCount++;
        accumulator.rootMergeModes.add(operation.mergeMode);
        break;
      case "ModeEntry":
        accumulator.modeEntryCount++;
        accumulator.entryModes.add(operation.mode);
        break;
      case "Use":
        accumulator.useCount++;
        break;
      case "For":
        accumulator.controlFlowCount++;
        collectEffects(operation.operations, accumulator);
        break;
      case "If":
        accumulator.controlFlowCount++;
        collectEffects(operation.thenOperations, accumulator);
        collectEffects(operation.elseOperations, accumulator);
        break;
      case "Unsupported":
        accumulator.unsupportedCount++;
        break;
    }
  }
}

function isSingleMergeProgram(
  program: RootTemplateOperationProgram,
  effects: RootTemplateOperationEffects
): boolean {
  if (
    effects.rootMergeCount !== 1
    || effects.modeEntryCount !== 0
    || effects.useCount !== 0
    || effects.controlFlowCount !== 0
    || effects.unsupportedCount !== 0
  ) {
    return false;
  }
  return program.operations.every(operation =>
    operation.kind === "ParameterBinding"
    || operation.kind === "Let"
    || operation.kind === "RootMerge"
  );
}

function valueHelperSafety(
  template: TemplateDeclNode,
  model: RsglSemanticModel,
  calls: readonly RootTemplateCallSite[]
): string | undefined {
  if (isModuleExported(template, model)) {
    return "The template is exported, so cross-module use sites cannot be rewritten by a single-file migration.";
  }
  if (template.parameters.some(parameter => parameter.defaultValue)) {
    return "Template defaults must retain definition-module binding and cannot be represented by the generated value helper.";
  }
  if (template.parameters.some(parameter => !parameter.name || !parameter.typeAnnotation)) {
    return "Value-helper extraction requires named, explicitly typed parameters.";
  }
  if (template.parameters.some(parameter => !hasEquivalentLambdaRuntimeBinding(parameter.typeAnnotation!))) {
    return "A parameter type requires template-only runtime normalization, so lambda extraction is not equivalent.";
  }

  const lets = bodyOperations(template).filter(
    (operation): operation is Extract<RootTemplateMigrationOperation, { kind: "Let" }> => operation.kind === "Let"
  );
  if (lets.some(operation => !operation.statement.name || operation.statement.typeAnnotation)) {
    return "Typed or missing-name local lets cannot be moved into a semantics-equivalent expression binding.";
  }
  const merge = bodyOperations(template).find(
    (operation): operation is Extract<RootTemplateMigrationOperation, { kind: "RootMerge" }> => operation.kind === "RootMerge"
  );
  if (!merge) {
    return "The template does not contain a root merge.";
  }
  const definitionExpressions = [
    ...lets.map(operation => operation.statement.value),
    merge.statement.value
  ];
  const resolveBuiltinEffect = semanticBuiltinEffectResolver(model);
  if (definitionExpressions.some(expression =>
    findLambdaImpureCalls(expression, resolveBuiltinEffect).length > 0
  )) {
    return "The merge/default/local binding performs an effect that is forbidden in a value-helper lambda.";
  }
  const captureSafety = valueHelperCaptureSafety(template, model, lets, merge);
  if (captureSafety) {
    return captureSafety;
  }
  if (hasCommentsWithin(template.body.range, model.module.tokens)) {
    return "The generated value helper would relocate comments inside the template body.";
  }
  return callSiteSafety(template, model, calls, false);
}

function semanticBuiltinEffectResolver(model: RsglSemanticModel): LambdaBuiltinEffectResolver {
  const symbolsByRange = new Map(
    model.references.map(reference => [textRangeKey(reference.range), reference.symbol] as const)
  );
  return (_name, range) => resolvedBuiltinEffect(symbolsByRange.get(textRangeKey(range)));
}

function textRangeKey(range: TextRange): string {
  return `${range.start}:${range.end}`;
}

function mixedInlineSafety(
  template: TemplateDeclNode,
  model: RsglSemanticModel,
  effects: RootTemplateOperationEffects,
  calls: readonly RootTemplateCallSite[]
): string | undefined {
  if (effects.rootMergeCount !== 1 || effects.rootMergeModes.length !== 1) {
    return "Mixed inlining is withheld for multiple root merges or merge modes.";
  }
  if (effects.entryModes.length !== 1) {
    return "Mixed inlining requires one proven blockstate entry mode.";
  }
  if (effects.parameterCount > 0 || effects.defaultBindingCount > 0 || effects.letCount > 0) {
    return "Mixed inlining requires parameter/default/local binding synthesis and cannot yet prove hygiene.";
  }
  if (effects.useCount > 0) {
    return "Nested template use prevents a self-contained inline expansion proof.";
  }
  if (isModuleExported(template, model)) {
    return "The template is exported, so removing it would break cross-module callers.";
  }
  if (calls.length === 0) {
    return "An unreferenced mixed root template is retained for manual migration.";
  }
  if (hasExternalBodyReferences(template, model)) {
    return "Inlining could capture a caller binding or change a definition-module closure reference.";
  }
  return callSiteSafety(template, model, calls, true, effects.entryModes[0]);
}

function callSiteSafety(
  template: TemplateDeclNode,
  model: RsglSemanticModel,
  calls: readonly RootTemplateCallSite[],
  requireNoArguments: boolean,
  requiredMode?: BlockstateMode
): string | undefined {
  const referencedRanges = model.references
    .filter(reference => reference.symbol?.node === template)
    .map(reference => `${reference.range.start}:${reference.range.end}`);
  const callRanges = calls.map(call => {
    const expression = call.statement.expression;
    return expression.kind === "CallExpr" ? expression.callee.range : expression.range;
  }).map(range => `${range.start}:${range.end}`);
  if (referencedRanges.some(range => !callRanges.includes(range))) {
    return "The template has a reference that is not a same-module use call.";
  }
  for (const call of calls) {
    const context = call.record.callerContext;
    if (
      !context
      || context.kind !== "blockstateRoot"
      || !context.allowRootMerge
      || context.mode === "neutral"
    ) {
      return "A use site is not a concrete blockstate root with root-merge capability.";
    }
    if (requiredMode && context.mode !== requiredMode) {
      return "A use site selects a different blockstate mode from the inlined entries.";
    }
    if (
      requireNoArguments
      && (
        call.statement.expression.kind !== "CallExpr"
        || call.statement.expression.args.length !== 0
      )
    ) {
      return "Mixed inlining requires a zero-argument call to avoid duplicated or reordered evaluation.";
    }
  }
  return undefined;
}

function produceRootTemplateEdits(
  sourceText: string,
  model: RsglSemanticModel,
  symbols: MigrationSymbolResolution,
  template: TemplateDeclNode,
  analysis: RootTemplateMigrationAnalysis
): { edits: TextEdit[]; issue?: undefined } | { edits: []; issue: MigrationIssue } {
  if (analysis.strategy === "manual") {
    return { edits: [], issue: manualIssue(template.range, analysis.reason) };
  }

  const syntax = collectLegacyBlockstateSyntaxEdits(
    model.module,
    model.module.tokens,
    template.body.range,
    symbols
  );
  if (syntax.unsupportedRange) {
    return {
      edits: [],
      issue: manualIssue(
        syntax.unsupportedRange,
        "A legacy model apply in the root template has no proven canonical rewrite."
      )
    };
  }

  if (analysis.strategy === "entryTemplate") {
    const mode = analysis.effects.entryModes[0];
    const header = templateOutputHeaderEdit(template, mode, model.module.tokens);
    if (!header) {
      return { edits: [], issue: manualIssue(template.range, "The template header could not be edited safely.") };
    }
    const bodyEdits = canonicalBodyEdits(
      sourceText,
      model,
      template.body.range,
      syntax.edits,
      mode
    );
    return bodyEdits
      ? { edits: [header, ...bodyEdits] }
      : { edits: [], issue: manualIssue(template.body.range, "Legacy entry wrappers overlap or cannot be unwrapped safely.") };
  }

  const calls = collectCallSites(template, model);
  if (analysis.strategy === "rootMergeValueHelper") {
    const helper = renderValueHelper(sourceText, analysis.program);
    if (!helper) {
      return { edits: [], issue: manualIssue(template.range, "The value-helper source could not be rendered safely.") };
    }
    const merge = bodyOperations(template).find(
      (operation): operation is Extract<RootTemplateMigrationOperation, { kind: "RootMerge" }> => operation.kind === "RootMerge"
    )!;
    const callEdits = calls.map(call => useToMergeEdit(call.statement, merge.statement, model.module.tokens));
    if (callEdits.some(edit => !edit)) {
      return { edits: [], issue: manualIssue(template.range, "A root-template use token could not be located.") };
    }
    return {
      edits: [
        { range: template.range, newText: helper },
        ...(callEdits as TextEdit[])
      ]
    };
  }

  const transformedBody = transformedTemplateBody(
    sourceText,
    model,
    template,
    syntax.edits,
    analysis.effects.entryModes[0]
  );
  if (transformedBody === undefined) {
    return { edits: [], issue: manualIssue(template.body.range, "The mixed template body could not be inlined safely.") };
  }
  return {
    edits: [
      { range: removableStatementRange(sourceText, template.range), newText: "" },
      ...calls.map(call => ({
        range: call.statement.range,
        newText: indentInlineBody(sourceText, call.statement.range.start, transformedBody)
      }))
    ]
  };
}

function canonicalBodyEdits(
  sourceText: string,
  model: RsglSemanticModel,
  bodyRange: TextRange,
  syntaxEdits: readonly TextEdit[],
  mode: BlockstateMode
): TextEdit[] | undefined {
  const wrappers = collectWrappers(model, bodyRange).filter(wrapper => wrapperMode(wrapper) === mode);
  const wrapperEdits: TextEdit[] = [];
  for (const wrapper of wrappers) {
    if (wrappers.some(other => other !== wrapper && containsRange(other.range, wrapper.range))) {
      return undefined;
    }
    const replacement = createWrapperReplacement(sourceText, model.module.tokens, wrapper, syntaxEdits);
    if (!replacement) {
      return undefined;
    }
    wrapperEdits.push(replacement);
  }
  return [
    ...syntaxEdits.filter(edit => !wrappers.some(wrapper => containsRange(wrapper.range, edit.range))),
    ...wrapperEdits
  ];
}

function transformedTemplateBody(
  sourceText: string,
  model: RsglSemanticModel,
  template: TemplateDeclNode,
  syntaxEdits: readonly TextEdit[],
  mode: BlockstateMode
): string | undefined {
  const opening = findSourceToken(
    model.module.tokens,
    template.body.range.start,
    template.body.range.end,
    "{"
  );
  const closing = findLastSourceToken(
    model.module.tokens,
    template.body.range.start,
    template.body.range.end,
    "}"
  );
  if (!opening || !closing) {
    return undefined;
  }
  const edits = canonicalBodyEdits(
    sourceText,
    model,
    template.body.range,
    syntaxEdits,
    mode
  );
  if (!edits) {
    return undefined;
  }
  const start = opening.offset + opening.length;
  const end = closing.offset;
  const relative = edits
    .filter(edit => start <= edit.range.start && edit.range.end <= end)
    .map(edit => ({
      range: { start: edit.range.start - start, end: edit.range.end - start },
      newText: edit.newText
    }));
  return trimBodyContent(applyTextEdits(sourceText.slice(start, end), relative));
}

function renderValueHelper(
  sourceText: string,
  program: RootTemplateOperationProgram
): string | undefined {
  const template = program.template;
  const name = template.name?.text;
  if (!name) {
    return undefined;
  }
  const body = bodyOperations(template);
  const merge = body.find(
    (operation): operation is Extract<RootTemplateMigrationOperation, { kind: "RootMerge" }> => operation.kind === "RootMerge"
  );
  if (!merge) {
    return undefined;
  }
  let expression = dedentExpression(
    sourceText.slice(merge.statement.value.range.start, merge.statement.value.range.end)
  );
  const lets = body.filter(
    (operation): operation is Extract<RootTemplateMigrationOperation, { kind: "Let" }> => operation.kind === "Let"
  );
  for (let index = lets.length - 1; index >= 0; index--) {
    const local = lets[index].statement;
    if (!local.name) {
      return undefined;
    }
    const value = dedentExpression(sourceText.slice(local.value.range.start, local.value.range.end));
    expression = `((${local.name.text}) => ${expression})(${value})`;
  }
  const parameterTypes = template.parameters.map(parameter =>
    sourceText.slice(parameter.typeAnnotation!.range.start, parameter.typeAnnotation!.range.end)
  );
  const parameterNames = template.parameters.map(parameter => parameter.name!.text);
  const lambdaHead = parameterNames.length === 1
    ? parameterNames[0]
    : `(${parameterNames.join(", ")})`;
  return `let ${name}: (${parameterTypes.join(", ")}) -> Json = ${lambdaHead} => ${expression}`;
}

function useToMergeEdit(
  use: UseDeclNode,
  merge: MergeStmtNode,
  tokens: readonly RsglToken[]
): TextEdit | undefined {
  const keyword = findSourceToken(tokens, use.range.start, use.expression.range.start, "use");
  if (!keyword) {
    return undefined;
  }
  return {
    range: { start: keyword.offset, end: keyword.offset + keyword.length },
    newText: merge.mode === "shallow" ? "merge" : `merge ${merge.modifier?.text ?? merge.mode}`
  };
}

function templateOutputHeaderEdit(
  template: TemplateDeclNode,
  mode: BlockstateMode,
  tokens: readonly RsglToken[]
): TextEdit | undefined {
  const opening = findSourceToken(tokens, template.body.range.start, template.body.range.end, "{");
  if (!opening) {
    return undefined;
  }
  const preceding = [...tokens]
    .reverse()
    .find(token => template.range.start <= token.offset && token.offset + token.length <= opening.offset);
  if (!preceding) {
    return undefined;
  }
  const offset = preceding.offset + preceding.length;
  return { range: { start: offset, end: offset }, newText: ` -> ${mode}` };
}

function collectCallSites(
  template: TemplateDeclNode,
  model: RsglSemanticModel
): RootTemplateCallSite[] {
  const useByExpression = new Map<RsglNode, UseDeclNode>();
  walkRsglModule(model.module, {
    enterStatement(statement) {
      if (statement.kind === "UseDecl") {
        useByExpression.set(statement.expression, statement);
      }
    }
  });
  const calls: RootTemplateCallSite[] = [];
  for (const record of model.templateUses ?? []) {
    const expression = record.expression;
    if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
      continue;
    }
    const reference = model.references.find(candidate =>
      candidate.range.start === expression.callee.range.start
      && candidate.range.end === expression.callee.range.end
    );
    const statement = useByExpression.get(expression);
    if (reference?.symbol?.node === template && statement) {
      calls.push({ statement, record });
    }
  }
  return calls;
}

function collectWrappers(
  model: RsglSemanticModel,
  range: TextRange
): LegacyBlockstateWrapper[] {
  const wrappers: LegacyBlockstateWrapper[] = [];
  walkRsglModule(model.module, {
    enterStatement(statement) {
      if (!containsRange(range, statement.range)) {
        return containsRange(statement.range, range) ? undefined : "skipChildren";
      }
      if (statement.kind === "VariantsSection" || statement.kind === "MultipartSection") {
        wrappers.push(statement);
      }
    }
  });
  return wrappers;
}

function isLegacyRootTemplateCandidate(
  symbol: RsglSymbol,
  template: TemplateDeclNode
): boolean {
  if (template.outputSyntax !== "noArrow") {
    return false;
  }
  const metadata = symbol.signature?.templateOutput;
  if (!metadata) {
    return false;
  }
  if (metadata.outputSource === "legacyInferredBody") {
    return metadata.legacyOutputDialect.kind === "blockstateRoot"
      || metadata.legacyOutputDialect.kind === "blockstateEntries";
  }
  if (metadata.outputSource !== "legacyContextualAdapter") {
    return false;
  }
  return bodyOperations(template).some(operation =>
    operation.kind === "RootMerge"
    || operation.kind === "ModeEntry"
    || (operation.kind === "Unsupported" && operation.statement.kind === "BaseStmt")
  );
}

function bodyOperations(template: TemplateDeclNode): RootTemplateMigrationOperation[] {
  return operationsFromStatements(template.body.statements);
}

function isModuleExported(template: TemplateDeclNode, model: RsglSemanticModel): boolean {
  const name = template.name?.text;
  if (!name) {
    return false;
  }
  // RSGL modules without an explicit export declaration implicitly expose all
  // top-level symbols. Replacing such a template with a value helper (or
  // deleting it for inlining) can therefore break callers outside the source
  // file even when the currently bound program has no visible import site.
  return model.exports.length === 0 || model.exports.some(record =>
    !record.source && record.specifiers.some(specifier => specifier.local === name)
  );
}

function valueHelperCaptureSafety(
  template: TemplateDeclNode,
  model: RsglSemanticModel,
  lets: readonly Extract<RootTemplateMigrationOperation, { kind: "Let" }>[],
  merge: Extract<RootTemplateMigrationOperation, { kind: "RootMerge" }>
): string | undefined {
  const body = bodyOperations(template);
  const allLocalLets = new Set(lets.map(operation => operation.statement));
  const availableLocalLets = new Set<LetDeclNode>();
  const parameters = new Set(template.parameters);
  let mergeSeen = false;

  for (const operation of body) {
    if (operation.kind === "RootMerge") {
      mergeSeen = true;
      const capture = unsafeValueHelperExpressionReference(
        operation.statement.value,
        model,
        parameters,
        allLocalLets,
        availableLocalLets
      );
      if (capture) {
        return capture;
      }
      continue;
    }
    if (operation.kind !== "Let") {
      continue;
    }
    if (mergeSeen) {
      return "A local binding after the root merge would be evaluated in a different order by the generated value helper.";
    }
    const capture = unsafeValueHelperExpressionReference(
      operation.statement.value,
      model,
      parameters,
      allLocalLets,
      availableLocalLets
    );
    if (capture) {
      return capture;
    }
    availableLocalLets.add(operation.statement);
  }

  // Keep the relationship explicit even though isSingleMergeProgram currently
  // guarantees the same node. This avoids silently approving a future IR shape
  // that separates analysis and rendering selections.
  if (!mergeSeen || !body.some(operation =>
    operation.kind === "RootMerge" && operation.statement === merge.statement
  )) {
    return "The analyzed root merge is not part of the rendered value-helper operation sequence.";
  }
  return undefined;
}

function unsafeValueHelperExpressionReference(
  expression: ExprNode,
  model: RsglSemanticModel,
  parameters: ReadonlySet<ParameterNode>,
  allLocalLets: ReadonlySet<LetDeclNode>,
  availableLocalLets: ReadonlySet<LetDeclNode>
): string | undefined {
  const references = model.references.filter(reference => containsRange(expression.range, reference.range));
  for (const reference of references) {
    const symbol = reference.symbol;
    if (symbol?.kind === "builtin") {
      continue;
    }
    const definition = symbol?.node;
    if (definition && parameters.has(definition as ParameterNode)) {
      continue;
    }
    if (definition && availableLocalLets.has(definition as LetDeclNode)) {
      continue;
    }
    // Parameters introduced by a nested lambda are contained by the expression
    // and remain local after the source expression is moved verbatim.
    if (definition && containsRange(expression.range, definition.range)) {
      continue;
    }
    if (definition && allLocalLets.has(definition as LetDeclNode)) {
      return `The value-helper expression references local binding '${reference.name}' before that binding is available.`;
    }
    return `The value-helper expression captures external binding '${reference.name}', so definition-module closure behavior cannot be preserved.`;
  }
  return undefined;
}

function hasExternalBodyReferences(template: TemplateDeclNode, model: RsglSemanticModel): boolean {
  return model.references.some(reference => {
    if (!containsRange(template.body.range, reference.range)) {
      return false;
    }
    const node = reference.symbol?.node;
    return !node || !containsRange(template.body.range, node.range);
  });
}

function hasEquivalentLambdaRuntimeBinding(type: TypeNode): boolean {
  if (type.kind !== "NamedType") {
    return false;
  }
  return type.name.text === "String"
    || type.name.text === "Number"
    || type.name.text === "Boolean"
    || type.name.text === "Json"
    || type.name.text === "Path";
}

function hasCommentsWithin(range: TextRange, tokens: readonly RsglToken[]): boolean {
  return tokens.some(token => token.leadingTrivia.some(trivia =>
    range.start <= trivia.offset
    && trivia.offset + trivia.length <= range.end
    && (trivia.kind === "lineComment" || trivia.kind === "blockComment")
  ));
}

function findLastSourceToken(
  tokens: readonly RsglToken[],
  start: number,
  end: number,
  text: string
): RsglToken | undefined {
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    if (start <= token.offset && token.offset + token.length <= end && token.text === text) {
      return token;
    }
  }
  return undefined;
}

function trimBodyContent(content: string): string {
  const withoutOpening = content.replace(/^\s*\r?\n/u, "");
  return withoutOpening.replace(/\r?\n[ \t]*$/u, "");
}

function dedentExpression(expression: string): string {
  const lines = expression.split(/\r?\n/u);
  if (lines.length < 2) {
    return expression;
  }
  const continuation = lines.slice(1).filter(line => line.trim().length > 0);
  const indent = continuation.length === 0
    ? 0
    : Math.min(...continuation.map(leadingWhitespaceLength));
  const newline = expression.includes("\r\n") ? "\r\n" : "\n";
  return [
    lines[0],
    ...lines.slice(1).map(line => line.slice(Math.min(indent, leadingWhitespaceLength(line))))
  ].join(newline);
}

function indentInlineBody(sourceText: string, offset: number, body: string): string {
  const lineStart = sourceText.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const prefix = sourceText.slice(lineStart, offset);
  const indent = /^[ \t]*$/u.test(prefix) ? prefix : "";
  const lines = body.split(/\r?\n/u);
  const nonBlank = lines.filter(line => line.trim().length > 0);
  const commonIndent = nonBlank.length === 0
    ? 0
    : Math.min(...nonBlank.map(leadingWhitespaceLength));
  return lines.map((line, index) => {
    const normalized = line.slice(Math.min(commonIndent, leadingWhitespaceLength(line)));
    return index === 0 ? normalized : indent + normalized;
  }).join(sourceText.includes("\r\n") ? "\r\n" : "\n");
}

function removableStatementRange(sourceText: string, range: TextRange): TextRange {
  const lineStart = sourceText.lastIndexOf("\n", Math.max(0, range.start - 1)) + 1;
  const lineFeed = sourceText.indexOf("\n", range.end);
  const lineEnd = lineFeed < 0 ? sourceText.length : lineFeed + 1;
  const prefix = sourceText.slice(lineStart, range.start);
  const suffix = sourceText.slice(range.end, lineFeed < 0 ? sourceText.length : lineFeed);
  return /^[ \t]*$/u.test(prefix) && /^[ \t\r]*$/u.test(suffix)
    ? { start: lineStart, end: lineEnd }
    : range;
}

function leadingWhitespaceLength(value: string): number {
  let length = 0;
  while (length < value.length && (value[length] === " " || value[length] === "\t")) {
    length++;
  }
  return length;
}

function wrapperMode(wrapper: LegacyBlockstateWrapper): BlockstateMode {
  return wrapper.kind === "VariantsSection" ? "variants" : "multipart";
}

function manual(
  program: RootTemplateOperationProgram,
  effects: RootTemplateOperationEffects,
  reason: string
): RootTemplateMigrationAnalysis {
  return { program, effects, strategy: "manual", reason };
}

function manualIssue(range: TextRange, reason?: string): MigrationIssue {
  return {
    code: "manualRootTemplateMigrationRequired",
    message: reason
      ? `Legacy blockstate root template requires manual migration. ${reason}`
      : "Legacy blockstate root template requires manual ordered-operation migration.",
    severity: "warning",
    range
  };
}
