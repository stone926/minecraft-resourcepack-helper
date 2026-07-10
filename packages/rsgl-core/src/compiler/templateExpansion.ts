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
  EvaluationValue,
  expressionEvaluationOrigin,
  RawGlobLoader,
  evaluateExpression
} from "./evaluate";
import type { BaseDocumentLoader, CompileDependency } from "./base/types";
import { RsglCompileDiagnostic } from "./ir";
import { RsglType, typeFromAnnotation } from "../semantic/types";
import { isRsglStdlibVirtualFileName } from "../stdlib";

export type RsglCompileContext = EvaluationContext & {
  templates?: Map<string, RsglTemplateDefinition>;
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
  options: TemplateExpansionOptions
): TemplateExpansion | undefined {
  if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
    return undefined;
  }
  const templateName = expression.callee.name.text;
  const template = (context.templates ?? options.templates).get(templateName);
  if (!template) {
    return undefined;
  }
  const recursionKey = `use ${templateName}`;
  if ((context.expansionStack ?? []).some(frame => frame.label === recursionKey)) {
    options.onError("rsgl.templateRecursion", `Template '${template.name}' cannot recursively expand itself.`, expression.range);
    return undefined;
  }

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
    template.fileName,
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
      { label: recursionKey, sourceRange: expression.range }
    ]
  });
  templateContext.valueOrigins = new Map([
    ...(templateBaseContext.valueOrigins ?? []),
    ...binding.origins
  ]);
  templateContext.stateKeyAliases = callableStateKeyAliases(templateBaseContext, parameters);
  return { definition: template, context: templateContext };
}

export function templateResourceBody(body: TemplateBodyNode): ResourceBodyNode | null {
  if (body.kind === "ResourceBody") {
    return body;
  }
  return blockAsResourceBody(body);
}

interface BoundCallableValues {
  values: Record<string, EvaluationValue>;
  origins: Map<string, EvaluationOrigin>;
}

function bindCallableValues(
  parameters: TemplateCallParameter[],
  expression: Extract<ExprNode, { kind: "CallExpr" }>,
  callContext: RsglCompileContext,
  definitionContext: RsglCompileContext,
  definitionFileName: string,
  label: "template",
  options: TemplateExpansionOptions
): BoundCallableValues | null {
  const values: Record<string, EvaluationValue> = {};
  const origins = new Map<string, EvaluationOrigin>();
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

  const argsByParameter = new Map(binding.primaryAssignments.map(assignment => [assignment.parameter.name, assignment.arg]));
  const argumentNamespace = isRsglStdlibVirtualFileName(definitionFileName)
    ? callContext.namespace
    : definitionContext.namespace;
  for (const parameter of parameters) {
    const name = parameter.name;
    const arg = argsByParameter.get(name);
    if (arg) {
      values[name] = normalizeCallableValue(evaluateExpression(arg.value, callContext), parameter.type, argumentNamespace);
      const inheritedOrigin = expressionEvaluationOrigin(arg.value, callContext);
      const sourceFile = inheritedOrigin?.sourceFile ?? callContext.sourceFile;
      if (sourceFile) {
        origins.set(name, inheritedOrigin ?? { sourceFile, sourceRange: arg.value.range });
      }
    } else if (parameter.parameterNode.defaultValue) {
      const defaultContext = options.createChildContext(definitionContext, values);
      defaultContext.valueOrigins = new Map([
        ...(definitionContext.valueOrigins ?? []),
        ...origins
      ]);
      values[name] = normalizeCallableValue(
        evaluateExpression(parameter.parameterNode.defaultValue, defaultContext),
        parameter.type,
        definitionContext.namespace
      );
      const inheritedOrigin = expressionEvaluationOrigin(parameter.parameterNode.defaultValue, defaultContext);
      if (inheritedOrigin) {
        origins.set(name, inheritedOrigin);
      } else if (definitionContext.sourceFile) {
        origins.set(name, {
          sourceFile: definitionContext.sourceFile,
          sourceRange: parameter.parameterNode.defaultValue.range
        });
      }
    }
  }
  return { values, origins };
}

function normalizeCallableValue(value: EvaluationValue, type: RsglType, namespace: string): EvaluationValue {
  if (
    (type.kind === "ResourceId" || type.kind === "ModelId" || type.kind === "TextureId") &&
    (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
  ) {
    const text = String(value);
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
