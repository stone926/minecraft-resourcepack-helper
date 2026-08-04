import {
  BlockNode,
  ExprNode,
  ParameterNode
} from "../parser";
import { bindRsglArguments, RsglCallableParameter } from "../arguments";
import { RsglTemplateDefinition } from "./environment";
import {
  EvaluationContext,
  type EvaluationOrigin,
  type EvaluationPathOrigin,
  type EvaluationValueIssue,
  EvaluationValue,
  evaluateExpressionResult,
  hasEvaluationValueBinding,
  materializeEvaluationPathOrigins,
  materializeEvaluationSelectionPathOrigins,
  materializeEvaluationValueIssues,
  originForEvaluationPath,
  RawGlobLoader,
} from "./evaluate";
import type { BaseDocumentLoader, CompileDependency } from "./base/types";
import { RsglCompileDiagnostic } from "./ir";
import { RsglType, typeFromAnnotation } from "../semantic/types";
import { contextualizeEvaluatedValue } from "./contextualResourceValueConversion";
import { isModuleNamespaceValue, type ModuleNamespaceValue } from "./moduleNamespaceValue";

export type RsglCompileContext = EvaluationContext & {
  templates?: Map<string, RsglTemplateDefinition>;
  /** Internal definition identities used for recursion detection; never emitted in source maps. */
  templateDefinitionStack?: readonly string[];
};

export type TemplateExpansion = {
  definition: RsglTemplateDefinition;
  context: RsglCompileContext;
};

type TemplateCallParameter = RsglCallableParameter & {
  parameterNode: ParameterNode;
  type: RsglType;
};

export interface TemplateExpansionOptions {
  templates: Map<string, RsglTemplateDefinition>;
  baseDocumentLoader?: BaseDocumentLoader;
  globLoader?: RawGlobLoader;
  onDependency?: (dependency: CompileDependency) => void;
  createChildContext: (
    context: RsglCompileContext,
    values: Record<string, EvaluationValue>,
    metadata?: Partial<Pick<EvaluationContext, "sourceFile" | "mappingReason" | "expansionStack">>
  ) => RsglCompileContext;
  onError: (code: string, message: string, range: { start: number; end: number }, fileName?: string) => void;
  onDiagnostic: (diagnostic: RsglCompileDiagnostic) => void;
}

export function createTemplateExpansion(
  expression: ExprNode,
  context: RsglCompileContext,
  options: TemplateExpansionOptions,
  resolvedDefinition?: RsglTemplateDefinition
): TemplateExpansion | undefined {
  if (expression.kind !== "CallExpr") {
    return undefined;
  }
  const templateName = templateCalleeDisplayName(expression.callee);
  if (!templateName) {
    return undefined;
  }
  const template = resolvedDefinition
    ?? resolveTemplateDefinition(expression, context, options.templates);
  if (!template) {
    return undefined;
  }
  const definitionIdentity = templateDefinitionIdentity(template);
  if ((context.templateDefinitionStack ?? []).includes(definitionIdentity)) {
    options.onError("rsgl.templateRecursion", `Template '${template.name}' cannot recursively expand itself.`, expression.range);
    return undefined;
  }
  const frameLabel = `use ${templateName}`;

  const templateBaseContext = createTemplateBaseContext(
    template,
    options,
    context.evaluationItemBudget,
    context.onEvaluationFailure,
    context.onResourceValueFailure
  );
  const resolvedParameters = new Map(
    template.signature?.parameters.map(parameter => [parameter.name, parameter]) ?? []
  );
  const parameters = template.node.parameters
    .filter(parameter => parameter.name)
        .map((parameter): TemplateCallParameter => ({
          name: parameter.name!.text,
          type: resolvedParameters.get(parameter.name!.text)?.type
            ?? typeFromAnnotation(parameter.typeAnnotation),
          optional: Boolean(parameter.defaultValue),
          node: parameter,
          parameterNode: parameter
    }));
  const binding = bindCallableValues(
    parameters,
    expression,
    context,
    templateBaseContext,
    "template",
    options
  );
  if (!binding) {
    return undefined;
  }

  const templateContext = options.createChildContext(templateBaseContext, binding.values, {
    sourceFile: template.fileName,
    mappingReason: "template",
    expansionStack: [
      ...(context.expansionStack ?? []),
      { label: frameLabel, sourceFile: context.sourceFile, sourceRange: expression.range }
    ]
  });
  templateContext.templateDefinitionStack = [
    ...(context.templateDefinitionStack ?? []),
    definitionIdentity
  ];
  templateContext.valueOrigins = new Map([
    ...(templateBaseContext.valueOrigins ?? []),
    ...binding.origins
  ]);
  templateContext.valuePathOrigins = new Map([
    ...(templateBaseContext.valuePathOrigins ?? []),
    ...binding.pathOrigins
  ]);
  templateContext.valueSelectionPathOrigins = new Map([
    ...(templateBaseContext.valueSelectionPathOrigins ?? []),
    ...binding.selectionPathOrigins
  ]);
  templateContext.valueIssues = new Map([
    ...(templateBaseContext.valueIssues ?? []),
    ...binding.valueIssues
  ]);
  if (template.node.body.kind === "Block") {
    templateContext.valueBindingNames = new Set([
      ...(templateContext.valueBindingNames ?? []),
      ...blockValueBindingNames(template.node.body)
    ]);
  }
  return { definition: template, context: templateContext };
}

/** Resolves a template definition without binding or evaluating any call arguments/defaults. */
export function resolveTemplateDefinition(
  expression: ExprNode,
  context: RsglCompileContext,
  templates: ReadonlyMap<string, RsglTemplateDefinition>
): RsglTemplateDefinition | undefined {
  if (expression.kind !== "CallExpr") {
    return undefined;
  }
  if (expression.callee.kind === "IdentifierExpr") {
    if (hasEvaluationValueBinding(context, expression.callee.name.text)) {
      return undefined;
    }
    return (context.templates ?? templates).get(expression.callee.name.text);
  }
  if (expression.callee.kind !== "MemberExpr") {
    return undefined;
  }
  const namespaceValue = resolveNamespaceExpression(expression.callee.object, context);
  return namespaceValue?.resolveTemplate(expression.callee.property.text);
}

function resolveNamespaceExpression(
  expression: ExprNode,
  context: RsglCompileContext
): ModuleNamespaceValue | undefined {
  if (expression.kind === "IdentifierExpr") {
    const value = context.variables.get(expression.name.text);
    return isModuleNamespaceValue(value) ? value : undefined;
  }
  if (expression.kind !== "MemberExpr") {
    return undefined;
  }
  const parent = resolveNamespaceExpression(expression.object, context);
  const value = parent?.resolveValue(expression.property.text)?.value;
  return isModuleNamespaceValue(value) ? value : undefined;
}

function templateCalleeDisplayName(expression: ExprNode): string | undefined {
  if (expression.kind === "IdentifierExpr") {
    return expression.name.text;
  }
  if (expression.kind !== "MemberExpr") {
    return undefined;
  }
  const objectName = templateCalleeDisplayName(expression.object);
  return objectName ? `${objectName}.${expression.property.text}` : undefined;
}

interface BoundCallableValues {
  values: Record<string, EvaluationValue>;
  origins: Map<string, EvaluationOrigin>;
  pathOrigins: Map<string, EvaluationPathOrigin[]>;
  selectionPathOrigins: Map<string, EvaluationPathOrigin[]>;
  valueIssues: Map<string, EvaluationValueIssue[]>;
}

function bindCallableValues(
  parameters: TemplateCallParameter[],
  expression: Extract<ExprNode, { kind: "CallExpr" }>,
  callContext: RsglCompileContext,
  definitionContext: RsglCompileContext,
  label: "template",
  options: TemplateExpansionOptions
): BoundCallableValues | null {
  const values: Record<string, EvaluationValue> = {};
  const origins = new Map<string, EvaluationOrigin>();
  const pathOrigins = new Map<string, EvaluationPathOrigin[]>();
  const selectionPathOrigins = new Map<string, EvaluationPathOrigin[]>();
  const valueIssues = new Map<string, EvaluationValueIssue[]>();
  const binding = bindRsglArguments(parameters, expression.args, {
    callRange: expression.range,
    codes: {
      duplicate: "rsgl.compileDuplicateArgument",
      missing: "rsgl.compileMissingArgument",
      tooMany: "rsgl.compileTooManyArguments",
      unknown: "rsgl.compileUnknownArgument"
    },
    messages: {
      duplicate: name => `Duplicate ${label} argument '${name}'.`,
      missing: parameter => `Missing ${label} argument '${parameter.name}'.`,
      tooMany: () => `Too many ${label} positional arguments.`,
      unknown: name => `Unknown ${label} argument '${name}'.`
    }
  });
  for (const diagnostic of binding.diagnostics) {
    options.onDiagnostic(diagnostic);
  }
  if (binding.diagnostics.some(diagnostic => diagnostic.severity === "error")) {
    return null;
  }

  const assignedNames = new Set<string>();
  const parametersByName = new Map(parameters.map(parameter => [parameter.name, parameter]));

  // Explicit arguments are effectful expressions. Preserve lexical call-site
  // order even when named arguments target parameters in another order.
  for (const assignment of [...binding.primaryAssignments]
    .sort((left, right) => left.arg.range.start - right.arg.range.start)) {
    const parameter = parametersByName.get(assignment.parameter.name);
    if (!parameter) {
      continue;
    }
    const name = parameter.name;
    const result = evaluateExpressionResult(assignment.arg.value, callContext);
    const normalized = normalizeCallableValue(
      result.value,
      parameter.type,
      callContext.namespace,
      assignment.arg.value.range,
      callContext,
      options
    );
    if (!normalized.ok) {
      return null;
    }
    values[name] = normalized.value;
    assignedNames.add(name);
    const materialized = materializeEvaluationPathOrigins(result, callContext.sourceFile);
    if (materialized.length > 0) {
      pathOrigins.set(name, materialized);
    }
    const materializedSelection = materializeEvaluationSelectionPathOrigins(
      result,
      callContext.sourceFile
    );
    if (materializedSelection.length > 0) {
      selectionPathOrigins.set(name, materializedSelection);
    }
    const origin = originForEvaluationPath(materialized, "") ?? result.origin;
    if (origin) {
      origins.set(name, origin);
    }
    const issues = materializeEvaluationValueIssues(result, callContext.sourceFile);
    if (issues.length > 0) {
      valueIssues.set(name, issues);
    }
  }

  // Defaults retain declaration/parameter order and definition-module scope.
  for (const parameter of parameters) {
    const name = parameter.name;
    if (assignedNames.has(name)) {
      continue;
    }
    if (parameter.parameterNode.defaultValue) {
      const defaultContext = options.createChildContext(definitionContext, values);
      defaultContext.valueOrigins = new Map([
        ...(definitionContext.valueOrigins ?? []),
        ...origins
      ]);
      defaultContext.valuePathOrigins = new Map([
        ...(definitionContext.valuePathOrigins ?? []),
        ...pathOrigins
      ]);
      defaultContext.valueSelectionPathOrigins = new Map([
        ...(definitionContext.valueSelectionPathOrigins ?? []),
        ...selectionPathOrigins
      ]);
      defaultContext.valueIssues = new Map([
        ...(definitionContext.valueIssues ?? []),
        ...valueIssues
      ]);
      const result = evaluateExpressionResult(parameter.parameterNode.defaultValue, defaultContext);
      const normalized = normalizeCallableValue(
        result.value,
        parameter.type,
        definitionContext.namespace,
        parameter.parameterNode.defaultValue.range,
        definitionContext,
        options
      );
      if (!normalized.ok) {
        return null;
      }
      values[name] = normalized.value;
      const materialized = materializeEvaluationPathOrigins(result, definitionContext.sourceFile);
      if (materialized.length > 0) {
        pathOrigins.set(name, materialized);
      }
      const materializedSelection = materializeEvaluationSelectionPathOrigins(
        result,
        definitionContext.sourceFile
      );
      if (materializedSelection.length > 0) {
        selectionPathOrigins.set(name, materializedSelection);
      }
      const origin = originForEvaluationPath(materialized, "") ?? result.origin;
      if (origin) {
        origins.set(name, origin);
      }
      const issues = materializeEvaluationValueIssues(result, definitionContext.sourceFile);
      if (issues.length > 0) {
        valueIssues.set(name, issues);
      }
    }
  }
  return { values, origins, pathOrigins, selectionPathOrigins, valueIssues };
}

function normalizeCallableValue(
  value: EvaluationValue,
  type: RsglType,
  namespace: string,
  range: { start: number; end: number },
  context: EvaluationContext,
  options: TemplateExpansionOptions
): { ok: true; value: EvaluationValue } | { ok: false } {
  // The expression evaluator owns the primary diagnostic for a failed
  // argument/default. Re-contextualizing its undefined sentinel would add a
  // misleading `resourceReferenceExpected` cascade at the same source site.
  if (value === undefined) {
    return { ok: false };
  }
  const converted = contextualizeEvaluatedValue(value, type, namespace);
  if (!converted.ok) {
    context.onEvaluationFailure?.();
    context.onResourceValueFailure?.();
    options.onError(
      converted.error.code,
      converted.error.message,
      range,
      context.sourceFile
    );
    return { ok: false };
  }
  return { ok: true, value: converted.value as EvaluationValue };
}

function createTemplateBaseContext(
  template: RsglTemplateDefinition,
  options: TemplateExpansionOptions,
  evaluationItemBudget: EvaluationContext["evaluationItemBudget"],
  onEvaluationFailure?: () => void,
  onResourceValueFailure?: () => void
): RsglCompileContext {
  return {
    namespace: template.namespace,
    variables: new Map(template.values),
    evaluationItemBudget,
    resolvedExpectedTypes: template.resolvedExpectedTypes,
    valueOrigins: template.valueOrigins ? new Map(template.valueOrigins) : undefined,
    valuePathOrigins: template.valuePathOrigins ? new Map(template.valuePathOrigins) : undefined,
    valueSelectionPathOrigins: template.valueSelectionPathOrigins
      ? new Map(template.valueSelectionPathOrigins)
      : undefined,
    valueIssues: template.valueIssues ? new Map(template.valueIssues) : undefined,
    valueBindingNames: new Set(template.values.keys()),
    sourceFile: template.fileName,
    mappingReason: "template",
    expansionStack: [],
    baseDocumentLoader: options.baseDocumentLoader,
    globLoader: options.globLoader,
    onDependency: options.onDependency,
    // Invariant: compile-phase contexts always carry onError so diagnostics
    // raised inside template bodies and parameter defaults are not swallowed.
    onError: options.onError,
    onEvaluationFailure,
    onResourceValueFailure,
    templates: template.templates
  };
}

function blockValueBindingNames(body: BlockNode): string[] {
  return body.statements.flatMap(statement =>
    (statement.kind === "LetDecl" || statement.kind === "TableDecl") && statement.name
      ? [statement.name.text]
      : []
  );
}

function templateDefinitionIdentity(template: RsglTemplateDefinition): string {
  return template.definitionFingerprint || JSON.stringify([
    template.fileName,
    template.node.name?.text ?? template.name,
    template.node.range.start,
    template.node.range.end
  ]);
}
