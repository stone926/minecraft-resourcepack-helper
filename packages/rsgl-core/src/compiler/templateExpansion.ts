import {
  BlockNode,
  ExprNode,
  ForStmtNode,
  ParameterNode,
  ResourceBodyNode,
  ResourceStatementNode,
  TemplateBodyNode,
  TopLevelStatementNode
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
  materializeEvaluationValueIssues,
  originForEvaluationPath,
  RawGlobLoader,
} from "./evaluate";
import type { BaseDocumentLoader, CompileDependency } from "./base/types";
import { RsglCompileDiagnostic } from "./ir";
import { RsglType, typeFromAnnotation } from "../semantic/types";

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
  if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
    return undefined;
  }
  const templateName = expression.callee.name.text;
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

  const templateBaseContext = createTemplateBaseContext(template, options);
  const parameters = template.node.parameters
    .filter(parameter => parameter.name)
        .map((parameter): TemplateCallParameter => ({
          name: parameter.name!.text,
          type: typeFromAnnotation(parameter.typeAnnotation),
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
  templateContext.valueIssues = new Map([
    ...(templateBaseContext.valueIssues ?? []),
    ...binding.valueIssues
  ]);
  templateContext.stateKeyAliases = callableStateKeyAliases(templateBaseContext, parameters);
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
  if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
    return undefined;
  }
  if (hasEvaluationValueBinding(context, expression.callee.name.text)) {
    return undefined;
  }
  return (context.templates ?? templates).get(expression.callee.name.text);
}

export function templateResourceBody(body: TemplateBodyNode): ResourceBodyNode | null {
  if (body.kind === "ResourceBody") {
    return body;
  }
  return body.kind === "Block" ? blockAsResourceBody(body) : null;
}

interface BoundCallableValues {
  values: Record<string, EvaluationValue>;
  origins: Map<string, EvaluationOrigin>;
  pathOrigins: Map<string, EvaluationPathOrigin[]>;
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
    values[name] = normalizeCallableValue(result.value, parameter.type, callContext.namespace);
    assignedNames.add(name);
    const materialized = materializeEvaluationPathOrigins(result, callContext.sourceFile);
    if (materialized.length > 0) {
      pathOrigins.set(name, materialized);
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
      defaultContext.valueIssues = new Map([
        ...(definitionContext.valueIssues ?? []),
        ...valueIssues
      ]);
      const result = evaluateExpressionResult(parameter.parameterNode.defaultValue, defaultContext);
      values[name] = normalizeCallableValue(
        result.value,
        parameter.type,
        definitionContext.namespace
      );
      const materialized = materializeEvaluationPathOrigins(result, definitionContext.sourceFile);
      if (materialized.length > 0) {
        pathOrigins.set(name, materialized);
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
  return { values, origins, pathOrigins, valueIssues };
}

function normalizeCallableValue(value: EvaluationValue, type: RsglType, namespace: string): EvaluationValue {
  if (
    (
      type.kind === "ResourceId"
      || type.kind === "ModelId"
      || type.kind === "TextureId"
      || type.kind === "TextureVariable"
      || type.kind === "TextureRef"
    ) &&
    (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
  ) {
    const text = String(value);
    if ((type.kind === "TextureVariable" || type.kind === "TextureRef") && text.startsWith("#")) {
      return text;
    }
    return text.includes(":") ? text : `${namespace}:${text}`;
  }
  return value;
}

function createTemplateBaseContext(
  template: RsglTemplateDefinition,
  options: TemplateExpansionOptions
): RsglCompileContext {
  return {
    namespace: template.namespace,
    variables: new Map(template.values),
    valueOrigins: template.valueOrigins ? new Map(template.valueOrigins) : undefined,
    valuePathOrigins: template.valuePathOrigins ? new Map(template.valuePathOrigins) : undefined,
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

function callableStateKeyAliases(
  context: RsglCompileContext,
  parameters: TemplateCallParameter[]
): ReadonlySet<string> {
  return new Set([
    ...(context.stateKeyAliases ?? []),
    ...parameters.map(parameter => parameter.name)
  ]);
}

function blockAsResourceBody(block: BlockNode): ResourceBodyNode | null {
  const statements: ResourceStatementNode[] = [];
  for (const statement of block.statements) {
    const converted = topLevelAsResourceStatement(statement);
    if (!converted) {
      return null;
    }
    statements.push(converted);
  }
  return {
    kind: "ResourceBody",
    statements,
    range: block.range,
    fullRange: block.fullRange
  };
}

function topLevelAsResourceStatement(statement: TopLevelStatementNode): ResourceStatementNode | null {
  if (statement.kind === "LetDecl" || statement.kind === "UseDecl" || statement.kind === "UnknownStmt") {
    return statement;
  }
  if (statement.kind === "ForStmt") {
    const body = bodyAsResourceBody(statement.body);
    return body ? { ...statement, body } : null;
  }
  if (statement.kind === "IfStmt") {
    const thenBody = bodyAsResourceBody(statement.thenBody);
    if (!thenBody) {
      return null;
    }
    if (!statement.elseBody) {
      return { ...statement, thenBody };
    }
    const elseBody = bodyAsResourceBody(statement.elseBody);
    return elseBody ? { ...statement, thenBody, elseBody } : null;
  }
  return null;
}

function bodyAsResourceBody(body: ForStmtNode["body"]): ResourceBodyNode | null {
  if (body.kind === "ResourceBody") {
    return body;
  }
  if (body.kind === "Block") {
    return blockAsResourceBody(body);
  }
  return null;
}
