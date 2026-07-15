import type {
  BlockstateChoiceBodyNode,
  BlockstateChoiceNode,
  BlockstateChoiceStatementNode,
  BlockstateRandomOptionNode,
  TextRange,
  UseDeclNode
} from "../parser";
import type {
  RsglTemplateCallerContext,
  TemplateOutputDispatch
} from "../templateOutput";
import type { RsglResourceValueObservation } from "./evaluatedResourceValues";
import {
  bindEvaluationResult,
  childEvaluationContext,
  evaluateCompileTimeCondition,
  evaluateExpressionResult,
  originForEvaluationPath,
  rangeForEvaluationPath
} from "./evaluate";
import type { RsglTemplateDefinition } from "./environment";
import type { JsonValue } from "./ir";
import {
  type BlockstateModelSpecLoweringHost,
  type BlockstateModelSpecMapping,
  lowerBlockstateModelSpec
} from "./blockstateModelSpecLowerer";
import { forEachLoopContext } from "./looping";
import { appendGeneratedPath, joinGeneratedPath } from "./sourcePaths";
import type { RsglCompileContext, TemplateExpansion } from "./templateExpansion";

export interface BlockstateChoiceExecutorHost extends BlockstateModelSpecLoweringHost {
  resolveTemplate(statement: UseDeclNode, context: RsglCompileContext): RsglTemplateDefinition | undefined;
  expandUse(
    statement: UseDeclNode,
    context: RsglCompileContext,
    definition: RsglTemplateDefinition
  ): TemplateExpansion | undefined;
  resolveTemplateDispatch(
    definition: RsglTemplateDefinition,
    callerContext: RsglTemplateCallerContext
  ): TemplateOutputDispatch;
}

export interface LoweredBlockstateChoice {
  readonly value: JsonValue;
  readonly mappings: readonly BlockstateModelSpecMapping[];
  readonly resourceValueObservations: readonly RsglResourceValueObservation[];
}

interface RandomAccumulator {
  readonly options: Record<string, JsonValue>[];
  readonly mappings: BlockstateModelSpecMapping[];
  readonly observations: RsglResourceValueObservation[];
}

/** Executes choice-local control flow into one random model array. */
export function executeBlockstateChoice(
  choice: BlockstateChoiceNode,
  context: RsglCompileContext,
  host: BlockstateChoiceExecutorHost
): LoweredBlockstateChoice | undefined {
  if (choice.kind === "BlockstateModelSpec") {
    return lowerBlockstateModelSpec(choice, context, host);
  }

  const accumulator: RandomAccumulator = {
    options: [],
    mappings: [{ generatedPath: "", sourceRange: choice.range, context }],
    observations: []
  };
  executeChoiceBody(
    choice.body,
    childEvaluationContext(context, {}),
    host,
    accumulator
  );
  if (accumulator.options.length === 0) {
    host.onError(
      "rsgl.emptyBlockstateRandom",
      "A random blockstate choice must expand to at least one option.",
      choice.range,
      context.sourceFile
    );
    return undefined;
  }
  return {
    value: accumulator.options,
    mappings: accumulator.mappings,
    resourceValueObservations: accumulator.observations
  };
}

function executeChoiceBody(
  body: BlockstateChoiceBodyNode,
  context: RsglCompileContext,
  host: BlockstateChoiceExecutorHost,
  accumulator: RandomAccumulator
): void {
  for (const statement of body.statements) {
    executeChoiceStatement(statement, context, host, accumulator);
  }
}

function executeChoiceStatement(
  statement: BlockstateChoiceStatementNode,
  context: RsglCompileContext,
  host: BlockstateChoiceExecutorHost,
  accumulator: RandomAccumulator
): void {
  switch (statement.kind) {
    case "BlockstateRandomOption":
      appendOption(statement, context, host, accumulator);
      return;
    case "LetDecl":
      if (statement.name) {
        bindEvaluationResult(
          context,
          statement.name.text,
          evaluateExpressionResult(statement.value, context)
        );
      }
      return;
    case "UseDecl":
      executeChoiceUse(statement, context, host, accumulator);
      return;
    case "ForStmt":
      forEachLoopContext(
        statement,
        context,
        (code, message, range) => host.onError(code, message, range, context.sourceFile),
        loopContext => {
          if (statement.body.kind !== "BlockstateChoiceBody") {
            host.onError(
              "rsgl.blockstateChoiceBoundaryMismatch",
              "A for-loop inside random must produce option statements.",
              statement.body.range,
              loopContext.sourceFile
            );
            return;
          }
          executeChoiceBody(statement.body, loopContext, host, accumulator);
        }
      );
      return;
    case "IfStmt": {
      const condition = evaluateCompileTimeCondition(statement.condition, context);
      if (condition === undefined) {
        return;
      }
      const selected = condition
        ? statement.thenBody
        : statement.elseBody;
      if (!selected) {
        return;
      }
      if (selected.kind !== "BlockstateChoiceBody") {
        host.onError(
          "rsgl.blockstateChoiceBoundaryMismatch",
          "An if statement inside random must produce option statements.",
          selected.range,
          context.sourceFile
        );
        return;
      }
      executeChoiceBody(
        selected,
        childEvaluationContext(context, {}),
        host,
        accumulator
      );
      return;
    }
    case "UnknownStmt":
      return;
    default:
      assertNever(statement);
  }
}

function appendOption(
  option: BlockstateRandomOptionNode,
  context: RsglCompileContext,
  host: BlockstateChoiceExecutorHost,
  accumulator: RandomAccumulator
): void {
  const index = accumulator.options.length;
  const optionPath = appendGeneratedPath("", String(index));
  const lowered = lowerBlockstateModelSpec(option.model, context, host);
  if (!lowered) {
    return;
  }
  const value = { ...lowered.value };
  let weightMapping: BlockstateModelSpecMapping | undefined;
  if (option.weight) {
    const result = evaluateExpressionResult(option.weight, context);
    const weight = result.value;
    if (typeof weight !== "number" || !Number.isInteger(weight) || weight <= 0) {
      host.onError(
        "rsgl.invalidRandomWeight",
        "Random option weight must evaluate to a positive integer.",
        option.weight.range,
        context.sourceFile
      );
      return;
    }
    if (weight !== 1) {
      value.weight = weight;
      weightMapping = {
        generatedPath: joinGeneratedPath(optionPath, "/weight"),
        sourceRange: rangeForEvaluationPath(result.pathRanges, "") ?? option.weight.range,
        context,
        ...(originForEvaluationPath(result.pathOrigins, "") ?? result.origin
          ? { origin: originForEvaluationPath(result.pathOrigins, "") ?? result.origin }
          : {})
      };
    }
  }
  accumulator.mappings.push({ generatedPath: optionPath, sourceRange: option.range, context });
  accumulator.mappings.push(...lowered.mappings
    .filter(mapping => mapping.generatedPath !== "")
    .map(mapping => ({
      ...mapping,
      generatedPath: joinGeneratedPath(optionPath, mapping.generatedPath)
    })));
  accumulator.observations.push(...lowered.resourceValueObservations.map(observation => ({
    ...observation,
    generatedPath: joinGeneratedPath(optionPath, observation.generatedPath)
  })));
  if (weightMapping) {
    accumulator.mappings.push(weightMapping);
  }
  accumulator.options.push(value);
}

function executeChoiceUse(
  statement: UseDeclNode,
  context: RsglCompileContext,
  host: BlockstateChoiceExecutorHost,
  accumulator: RandomAccumulator
): void {
  const definition = host.resolveTemplate(statement, context);
  if (!definition) {
    return;
  }
  const dispatch = host.resolveTemplateDispatch(definition, choiceCallerContext);
  if (!dispatch.compatible || dispatch.selectedDialect !== "choice") {
    return;
  }
  const expansion = host.expandUse(statement, context, definition);
  if (!expansion) {
    return;
  }
  if (definition.node.body.kind !== "BlockstateChoiceBody") {
    host.onError(
      "rsgl.blockstateChoiceBoundaryMismatch",
      `Template '${definition.name}' does not produce random options.`,
      statement.range,
      context.sourceFile
    );
    return;
  }
  executeChoiceBody(definition.node.body, expansion.context, host, accumulator);
}

const choiceCallerContext: RsglTemplateCallerContext = {
  kind: "blockstateChoice"
};

function assertNever(value: never): never {
  throw new Error(`Unhandled blockstate choice statement: ${JSON.stringify(value)}`);
}

export type BlockstateChoiceSourceRange = TextRange;
