import { createHash } from "node:crypto";
import {
  ExprNode,
  LetDeclNode,
  TableDeclNode,
  TemplateDeclNode,
  TextRange
} from "../parser";
import {
  createRsglExportMaps,
  RsglProgram,
  RsglSemanticModel,
  RsglSignature,
  RsglSymbol,
  RsglType
} from "../semantic";
import {
  EvaluationContext,
  type EvaluationResult,
  type EvaluationOrigin,
  type EvaluationPathOrigin,
  type EvaluationValueIssue,
  EvaluationValue,
  RawGlobLoader,
  bindEvaluationResult,
  evaluateExpressionResult,
  materializeEvaluationPathOrigins,
  materializeEvaluationValueIssues,
  originForEvaluationPath
} from "./evaluate";
import type { BaseDocumentLoader, CompileDependency } from "./base/types";
import {
  effectiveNamespace,
  type ResolvedRsglCompileConfiguration
} from "./compileConfiguration";
import { normalizeJsonValue } from "./compilerHelpers";
import type { ResolvedTemplateOutputMetadata } from "../templateOutput";
import {
  templateOutputMetadataFingerprint,
  templateOutputMetadataForDeclaration
} from "../templateOutput";
import { EvaluationItemBudget } from "./evaluationItemBudget";
import { ModuleNamespaceValue, isModuleNamespaceValue } from "./moduleNamespaceValue";
import { RsglPathKeyMap, rsglPathKey } from "../pathIdentity";

export interface RsglModuleCompileEnvironment {
  fileName: string;
  namespace: string;
  evaluationItemBudget: EvaluationItemBudget;
  resolvedExpectedTypes: ReadonlyMap<ExprNode, RsglType>;
  importedValues: Map<string, EvaluationValue>;
  importedValueOrigins: Map<string, EvaluationOrigin>;
  importedValuePathOrigins: Map<string, EvaluationPathOrigin[]>;
  importedValueIssues: Map<string, EvaluationValueIssue[]>;
  importedTemplates: Map<string, RsglTemplateDefinition>;
  /** Exact direct top-level evaluations keyed by their declaration node. */
  localEvaluationResults?: Map<LetDeclNode | TableDeclNode, EvaluationResult>;
  localValues: Map<string, EvaluationValue>;
  allValues: Map<string, EvaluationValue>;
  allValueOrigins: Map<string, EvaluationOrigin>;
  allValuePathOrigins: Map<string, EvaluationPathOrigin[]>;
  allValueIssues: Map<string, EvaluationValueIssue[]>;
  allTemplates: Map<string, RsglTemplateDefinition>;
  exportedValues: Map<string, EvaluationValue>;
  exportedValueOrigins: Map<string, EvaluationOrigin>;
  exportedValuePathOrigins: Map<string, EvaluationPathOrigin[]>;
  exportedValueIssues: Map<string, EvaluationValueIssue[]>;
  exportedTemplates: Map<string, RsglTemplateDefinition>;
}

export interface RsglTemplateDefinition {
  name: string;
  node: TemplateDeclNode;
  outputMetadata: ResolvedTemplateOutputMetadata;
  /** Immutable-input fingerprint used only for dispatch-plan caching. */
  definitionFingerprint: string;
  definitionTargetFingerprint: string;
  fileName: string;
  namespace: string;
  /** Linked signature, including resolved type aliases. */
  signature?: RsglSignature;
  /** Definition-module contextual facts used by defaults and the body. */
  resolvedExpectedTypes?: ReadonlyMap<ExprNode, RsglType>;
  values: Map<string, EvaluationValue>;
  valueOrigins?: Map<string, EvaluationOrigin>;
  valuePathOrigins?: Map<string, EvaluationPathOrigin[]>;
  valueIssues?: Map<string, EvaluationValueIssue[]>;
  templates: Map<string, RsglTemplateDefinition>;
}

export interface RsglExternalValueDefinition {
  name: string;
  value: EvaluationValue;
  origin?: EvaluationOrigin;
  pathOrigins?: readonly EvaluationPathOrigin[];
  valueIssues?: readonly EvaluationValueIssue[];
}

export interface RsglCompileEnvironmentOptions {
  /** Shared by every module and evaluation child in one compile pipeline run. */
  evaluationItemBudget?: EvaluationItemBudget;
  /**
   * Models whose import closures need runtime environments. Defaults to every
   * model for callers that inspect a complete semantic program.
   */
  rootModels?: readonly RsglSemanticModel[];
  baseDocumentLoader?: BaseDocumentLoader;
  globLoader?: RawGlobLoader;
  onDependency?: (dependency: CompileDependency) => void;
  /** Receives runtime diagnostics raised while imported/local values are pre-evaluated. */
  onError?: (code: string, message: string, range: TextRange, fileName?: string) => void;
  /** Marks a pre-evaluation failure even when another layer owns its diagnostic. */
  onEvaluationFailure?: () => void;
  /** Stable effective project configuration used by definition/dispatch fingerprints. */
  definitionFingerprintContext?: string;
}

export function createStandaloneCompileEnvironment(
  model: RsglSemanticModel,
  namespace: string,
  options: RsglCompileEnvironmentOptions = {}
): RsglModuleCompileEnvironment {
  const environment = createEmptyCompileEnvironment(
    model,
    namespace,
    options.evaluationItemBudget ?? new EvaluationItemBudget()
  );
  evaluateLocalEnvironmentValues(environment, model, options);
  collectLocalEnvironmentTemplates(environment, model);
  refreshEnvironmentTemplateFingerprints(
    environment,
    options.definitionFingerprintContext ?? JSON.stringify({ namespace })
  );
  return environment;
}

export function createProgramCompileEnvironments(
  program: RsglProgram,
  configuration: Pick<ResolvedRsglCompileConfiguration, "namespaceOverride" | "defaultNamespace">
    & Partial<Pick<ResolvedRsglCompileConfiguration, "semanticFingerprint">>,
  options: RsglCompileEnvironmentOptions = {}
): Map<string, RsglModuleCompileEnvironment> {
  const modelsByFile = new RsglPathKeyMap(program.models.map(model => [model.fileName, model] as const));
  const exportMaps = createRsglExportMaps(program.models, program.importGraph).maps;
  const environments = new RsglPathKeyMap<RsglModuleCompileEnvironment>();
  const evaluationItemBudget = options.evaluationItemBudget ?? new EvaluationItemBudget();

  const createEnvironment = (model: RsglSemanticModel): RsglModuleCompileEnvironment => {
    const fileName = rsglPathKey(model.fileName);
    const cached = environments.get(fileName);
    if (cached) {
      return cached;
    }

    const environment = createEmptyCompileEnvironment(
      model,
      effectiveNamespace(model.namespace, configuration),
      evaluationItemBudget
    );
    environments.set(fileName, environment);

    collectImportedEnvironmentBindings(environment, model, program, modelsByFile, createEnvironment);
    evaluateLocalEnvironmentValues(environment, model, options);
    collectLocalEnvironmentTemplates(environment, model);
    collectExportedEnvironmentBindings(environment, model, program, modelsByFile, exportMaps, createEnvironment);
    return environment;
  };

  for (const model of options.rootModels ?? program.models) {
    createEnvironment(model);
  }
  const fingerprintContext = "semanticFingerprint" in configuration
    ? String(configuration.semanticFingerprint)
    : JSON.stringify(configuration);
  for (const environment of environments.values()) {
    refreshEnvironmentTemplateFingerprints(environment, fingerprintContext);
  }
  return environments;
}

export function createTemplateDefinition(
  name: string,
  node: TemplateDeclNode,
  fileName: string,
  namespace: string,
  values: Map<string, EvaluationValue>,
  templates: Map<string, RsglTemplateDefinition>,
  outputMetadata: ResolvedTemplateOutputMetadata = templateOutputMetadataForDeclaration(node),
  definitionTargetFingerprint = "unresolved-target",
  definitionFingerprintContext = "unresolved-target",
  semantic?: {
    signature?: RsglSignature;
    resolvedExpectedTypes?: ReadonlyMap<ExprNode, RsglType>;
  }
): RsglTemplateDefinition {
  const definition: RsglTemplateDefinition = {
    name,
    node,
    outputMetadata,
    definitionFingerprint: "",
    definitionTargetFingerprint,
    fileName,
    namespace,
    ...(semantic?.signature ? { signature: semantic.signature } : {}),
    ...(semantic?.resolvedExpectedTypes
      ? { resolvedExpectedTypes: semantic.resolvedExpectedTypes }
      : {}),
    values,
    templates
  };
  refreshTemplateDefinitionFingerprint(definition, definitionFingerprintContext);
  return definition;
}

export function refreshTemplateDefinitionFingerprint(
  definition: RsglTemplateDefinition,
  targetContext: string
): string {
  definition.definitionFingerprint = calculateTemplateDefinitionFingerprint(
    definition,
    targetContext,
    new Map(),
    new Set()
  );
  return definition.definitionFingerprint;
}

export function mapToExternalValues(
  values: Map<string, EvaluationValue>,
  origins: ReadonlyMap<string, EvaluationOrigin> = new Map(),
  pathOrigins: ReadonlyMap<string, readonly EvaluationPathOrigin[]> = new Map(),
  valueIssues: ReadonlyMap<string, readonly EvaluationValueIssue[]> = new Map()
): RsglExternalValueDefinition[] {
  return Array.from(values, ([name, value]) => ({
    name,
    value,
    ...(origins.get(name) ? { origin: origins.get(name) } : {}),
    ...(pathOrigins.get(name) ? { pathOrigins: pathOrigins.get(name) } : {}),
    ...(valueIssues.get(name) ? { valueIssues: valueIssues.get(name) } : {})
  }));
}

function createEmptyCompileEnvironment(
  model: RsglSemanticModel,
  namespace: string,
  evaluationItemBudget: EvaluationItemBudget
): RsglModuleCompileEnvironment {
  return {
    fileName: model.fileName,
    namespace,
    evaluationItemBudget,
    resolvedExpectedTypes: model.resolvedExpectedTypes,
    importedValues: new Map(),
    importedValueOrigins: new Map(),
    importedValuePathOrigins: new Map(),
    importedValueIssues: new Map(),
    importedTemplates: new Map(),
    localEvaluationResults: new Map(),
    localValues: new Map(),
    allValues: new Map(),
    allValueOrigins: new Map(),
    allValuePathOrigins: new Map(),
    allValueIssues: new Map(),
    allTemplates: new Map(),
    exportedValues: new Map(),
    exportedValueOrigins: new Map(),
    exportedValuePathOrigins: new Map(),
    exportedValueIssues: new Map(),
    exportedTemplates: new Map()
  };
}

function collectImportedEnvironmentBindings(
  environment: RsglModuleCompileEnvironment,
  model: RsglSemanticModel,
  program: RsglProgram,
  modelsByFile: Map<string, RsglSemanticModel>,
  createEnvironment: (model: RsglSemanticModel) => RsglModuleCompileEnvironment
): void {
  for (const record of model.imports) {
    const targetModel = resolveModuleTargetModel(model, record.source, program, modelsByFile);
    if (!targetModel) {
      continue;
    }

    const targetEnvironment = createEnvironment(targetModel);
    const namespaceName = importedNamespaceName(record);
    if (namespaceName) {
      const namespaceValue = new ModuleNamespaceValue({
        fileName: targetEnvironment.fileName,
        namespace: targetEnvironment.namespace,
        values: targetEnvironment.exportedValues,
        valueOrigins: targetEnvironment.exportedValueOrigins,
        valuePathOrigins: targetEnvironment.exportedValuePathOrigins,
        valueIssues: targetEnvironment.exportedValueIssues,
        templates: targetEnvironment.exportedTemplates
      });
      environment.importedValues.set(namespaceName, namespaceValue);
      environment.allValues.set(namespaceName, namespaceValue);
    }
    if (record.importAll) {
      copyValueBindings(
        environment.importedValues,
        environment.importedValueOrigins,
        environment.importedValuePathOrigins,
        environment.importedValueIssues,
        targetEnvironment.exportedValues,
        targetEnvironment.exportedValueOrigins,
        targetEnvironment.exportedValuePathOrigins,
        targetEnvironment.exportedValueIssues
      );
      copyValueBindings(
        environment.allValues,
        environment.allValueOrigins,
        environment.allValuePathOrigins,
        environment.allValueIssues,
        targetEnvironment.exportedValues,
        targetEnvironment.exportedValueOrigins,
        targetEnvironment.exportedValuePathOrigins,
        targetEnvironment.exportedValueIssues
      );
      copyTemplates(environment.importedTemplates, targetEnvironment.exportedTemplates);
      copyTemplates(environment.allTemplates, targetEnvironment.exportedTemplates);
    }
    for (const item of record.namedImports) {
      if (targetEnvironment.exportedValues.has(item.imported)) {
        const value = targetEnvironment.exportedValues.get(item.imported);
        environment.importedValues.set(item.local, value);
        environment.allValues.set(item.local, value);
        copyAliasedValueProvenance(
          item.imported,
          item.local,
          targetEnvironment.exportedValueOrigins,
          targetEnvironment.exportedValuePathOrigins,
          environment.importedValueOrigins,
          environment.importedValuePathOrigins
        );
        copyAliasedValueIssues(
          item.imported,
          item.local,
          targetEnvironment.exportedValueIssues,
          environment.importedValueIssues
        );
        copyAliasedValueProvenance(
          item.imported,
          item.local,
          targetEnvironment.exportedValueOrigins,
          targetEnvironment.exportedValuePathOrigins,
          environment.allValueOrigins,
          environment.allValuePathOrigins
        );
        copyAliasedValueIssues(
          item.imported,
          item.local,
          targetEnvironment.exportedValueIssues,
          environment.allValueIssues
        );
      }

      const template = targetEnvironment.exportedTemplates.get(item.imported);
      if (template) {
        const aliasedTemplate = aliasTemplate(template, item.local);
        environment.importedTemplates.set(item.local, aliasedTemplate);
        environment.allTemplates.set(item.local, aliasedTemplate);
      }
    }
  }
}

function collectExportedEnvironmentBindings(
  environment: RsglModuleCompileEnvironment,
  model: RsglSemanticModel,
  program: RsglProgram,
  modelsByFile: Map<string, RsglSemanticModel>,
  exportMaps: Map<string, Map<string, RsglSymbol>>,
  createEnvironment: (model: RsglSemanticModel) => RsglModuleCompileEnvironment
): void {
  const semanticExports = exportMaps.get(rsglPathKey(model.fileName)) ?? new Map();
  for (const [exportedName, symbol] of semanticExports) {
    if (symbol && typeof symbol === "object" && "name" in symbol) {
      const localName = String(symbol.name);
      if (environment.allValues.has(localName)) {
        environment.exportedValues.set(exportedName, environment.allValues.get(localName));
        copyAliasedValueProvenance(
          localName,
          exportedName,
          environment.allValueOrigins,
          environment.allValuePathOrigins,
          environment.exportedValueOrigins,
          environment.exportedValuePathOrigins
        );
        copyAliasedValueIssues(
          localName,
          exportedName,
          environment.allValueIssues,
          environment.exportedValueIssues
        );
      }
      const template = environment.allTemplates.get(localName);
      if (template) {
        environment.exportedTemplates.set(exportedName, aliasTemplate(template, exportedName));
      }
    }
  }

  for (const record of model.exports) {
    if (!record.source) {
      continue;
    }
    const targetModel = resolveModuleTargetModel(model, record.source, program, modelsByFile);
    if (!targetModel) {
      continue;
    }
    const targetEnvironment = createEnvironment(targetModel);
    if (record.exportAll) {
      copyValueBindings(
        environment.exportedValues,
        environment.exportedValueOrigins,
        environment.exportedValuePathOrigins,
        environment.exportedValueIssues,
        targetEnvironment.exportedValues,
        targetEnvironment.exportedValueOrigins,
        targetEnvironment.exportedValuePathOrigins,
        targetEnvironment.exportedValueIssues
      );
      copyTemplates(environment.exportedTemplates, targetEnvironment.exportedTemplates);
    }
    for (const specifier of record.specifiers) {
      if (targetEnvironment.exportedValues.has(specifier.local)) {
        environment.exportedValues.set(specifier.exported, targetEnvironment.exportedValues.get(specifier.local));
        copyAliasedValueProvenance(
          specifier.local,
          specifier.exported,
          targetEnvironment.exportedValueOrigins,
          targetEnvironment.exportedValuePathOrigins,
          environment.exportedValueOrigins,
          environment.exportedValuePathOrigins
        );
        copyAliasedValueIssues(
          specifier.local,
          specifier.exported,
          targetEnvironment.exportedValueIssues,
          environment.exportedValueIssues
        );
      }
      const template = targetEnvironment.exportedTemplates.get(specifier.local);
      if (template) {
        environment.exportedTemplates.set(specifier.exported, aliasTemplate(template, specifier.exported));
      }
    }
  }
}

function evaluateLocalEnvironmentValues(
  environment: RsglModuleCompileEnvironment,
  model: RsglSemanticModel,
  options: RsglCompileEnvironmentOptions
): void {
  const context: EvaluationContext = {
    namespace: environment.namespace,
    variables: new Map(environment.importedValues),
    evaluationItemBudget: environment.evaluationItemBudget,
    resolvedExpectedTypes: environment.resolvedExpectedTypes,
    // Match semantic predeclaration: a later local value still shadows a
    // same-named builtin while earlier initializers are pre-evaluated. Without
    // this set, `let result = model_id(...); let model_id = ...` can silently
    // execute the constructor and export a branded value.
    valueBindingNames: new Set([
      ...environment.importedValues.keys(),
      ...model.module.statements.flatMap(statement =>
        (isLetDeclNode(statement) || isTableDeclNode(statement)) && statement.name
          ? [statement.name.text]
          : []
      )
    ]),
    valueOrigins: new Map(environment.importedValueOrigins),
    valuePathOrigins: new Map(environment.importedValuePathOrigins),
    valueIssues: new Map(environment.importedValueIssues),
    sourceFile: model.fileName,
    mappingReason: "direct",
    expansionStack: [],
    baseDocumentLoader: options.baseDocumentLoader,
    globLoader: options.globLoader,
    onDependency: options.onDependency,
    onError: options.onError,
    onEvaluationFailure: options.onEvaluationFailure
  };

  for (const statement of model.module.statements) {
    if (isLetDeclNode(statement) && statement.name) {
      const result = evaluateExpressionResult(statement.value, context);
      environment.localEvaluationResults?.set(statement, result);
      recordLocalEnvironmentValue(environment, context, statement.name.text, result, model.fileName);
    } else if (isTableDeclNode(statement) && statement.name) {
      const result = evaluateExpressionResult(statement.body, context);
      const normalizedResult = {
        ...result,
        value: normalizeJsonValue(result.value)
      };
      environment.localEvaluationResults?.set(statement, normalizedResult);
      recordLocalEnvironmentValue(environment, context, statement.name.text, normalizedResult, model.fileName);
    }
  }
}

function recordLocalEnvironmentValue(
  environment: RsglModuleCompileEnvironment,
  context: EvaluationContext,
  name: string,
  result: ReturnType<typeof evaluateExpressionResult>,
  sourceFile: string
): void {
  environment.localValues.set(name, result.value);
  environment.allValues.set(name, result.value);
  bindEvaluationResult(context, name, result, sourceFile);
  const materialized = materializeEvaluationPathOrigins(result, sourceFile);
  const origin = originForEvaluationPath(materialized, "") ?? result.origin;
  if (origin) {
    environment.allValueOrigins.set(name, origin);
  } else {
    environment.allValueOrigins.delete(name);
  }
  if (materialized.length > 0) {
    environment.allValuePathOrigins.set(name, materialized);
  } else {
    environment.allValuePathOrigins.delete(name);
  }
  const issues = materializeEvaluationValueIssues(result, sourceFile);
  if (issues.length > 0) {
    environment.allValueIssues.set(name, issues);
  } else {
    environment.allValueIssues.delete(name);
  }
}

function collectLocalEnvironmentTemplates(
  environment: RsglModuleCompileEnvironment,
  model: RsglSemanticModel
): void {
  for (const statement of model.module.statements) {
    if (statement.kind === "TemplateDecl" && statement.name) {
      const signature = model.scope.symbols.get(statement.name.text)?.signature;
      const outputMetadata = signature?.templateOutput
        ?? templateOutputMetadataForDeclaration(statement);
      const definition = createTemplateDefinition(
        statement.name.text,
        statement,
        model.fileName,
        environment.namespace,
        environment.allValues,
        environment.allTemplates,
        outputMetadata,
        JSON.stringify(model.module.statements.filter(statement => statement.kind === "TargetDecl")),
        "unresolved-target",
        {
          ...(signature ? { signature } : {}),
          resolvedExpectedTypes: model.resolvedExpectedTypes
        }
      );
      definition.valueOrigins = environment.allValueOrigins;
      definition.valuePathOrigins = environment.allValuePathOrigins;
      definition.valueIssues = environment.allValueIssues;
      environment.allTemplates.set(statement.name.text, definition);
    }
  }
}

function resolveModuleTargetModel(
  model: RsglSemanticModel,
  source: string,
  program: RsglProgram,
  modelsByFile: Map<string, RsglSemanticModel>
): RsglSemanticModel | undefined {
  const currentFile = rsglPathKey(model.fileName);
  const targetFile = program.importGraph.edges.find(edge =>
    rsglPathKey(edge.from) === currentFile && edge.source === source
  )?.to;
  return targetFile ? modelsByFile.get(rsglPathKey(targetFile)) : undefined;
}

function aliasTemplate(template: RsglTemplateDefinition, name: string): RsglTemplateDefinition {
  return template.name === name ? template : { ...template, name };
}

function copyValueBindings(
  target: Map<string, EvaluationValue>,
  targetOrigins: Map<string, EvaluationOrigin>,
  targetPathOrigins: Map<string, EvaluationPathOrigin[]>,
  targetIssues: Map<string, EvaluationValueIssue[]>,
  source: ReadonlyMap<string, EvaluationValue>,
  sourceOrigins: ReadonlyMap<string, EvaluationOrigin>,
  sourcePathOrigins: ReadonlyMap<string, readonly EvaluationPathOrigin[]>,
  sourceIssues: ReadonlyMap<string, readonly EvaluationValueIssue[]>
): void {
  for (const [name, value] of source) {
    if (!target.has(name)) {
      target.set(name, value);
      copyAliasedValueProvenance(
        name,
        name,
        sourceOrigins,
        sourcePathOrigins,
        targetOrigins,
        targetPathOrigins
      );
      copyAliasedValueIssues(name, name, sourceIssues, targetIssues);
    }
  }
}

function copyAliasedValueIssues(
  sourceName: string,
  targetName: string,
  source: ReadonlyMap<string, readonly EvaluationValueIssue[]>,
  target: Map<string, EvaluationValueIssue[]>
): void {
  const issues = source.get(sourceName);
  if (issues) {
    target.set(targetName, [...issues]);
  } else {
    target.delete(targetName);
  }
}

function copyAliasedValueProvenance(
  sourceName: string,
  targetName: string,
  sourceOrigins: ReadonlyMap<string, EvaluationOrigin>,
  sourcePathOrigins: ReadonlyMap<string, readonly EvaluationPathOrigin[]>,
  targetOrigins: Map<string, EvaluationOrigin>,
  targetPathOrigins: Map<string, EvaluationPathOrigin[]>
): void {
  const origin = sourceOrigins.get(sourceName);
  if (origin) {
    targetOrigins.set(targetName, origin);
  } else {
    targetOrigins.delete(targetName);
  }
  const pathOrigins = sourcePathOrigins.get(sourceName);
  if (pathOrigins) {
    targetPathOrigins.set(targetName, [...pathOrigins]);
  } else {
    targetPathOrigins.delete(targetName);
  }
}

function copyTemplates(target: Map<string, RsglTemplateDefinition>, source: Map<string, RsglTemplateDefinition>): void {
  for (const [name, template] of source) {
    if (!target.has(name)) {
      target.set(name, template);
    }
  }
}

function refreshEnvironmentTemplateFingerprints(
  environment: RsglModuleCompileEnvironment,
  targetContext: string
): void {
  const definitions = new Set([
    ...environment.allTemplates.values(),
    ...environment.exportedTemplates.values()
  ]);
  for (const definition of definitions) {
    refreshTemplateDefinitionFingerprint(definition, targetContext);
  }
}

function calculateTemplateDefinitionFingerprint(
  definition: RsglTemplateDefinition,
  targetContext: string,
  memo: Map<string, string>,
  active: Set<string>
): string {
  const sourceIdentity = templateDefinitionSourceIdentity(definition);
  const cached = memo.get(sourceIdentity);
  if (cached) {
    return cached;
  }
  if (active.has(sourceIdentity)) {
    return `recursive:${sourceIdentity}`;
  }

  active.add(sourceIdentity);
  const callees = collectTemplateCalleeReferences(definition.node)
    .map(reference => {
      const callee = reference.namespaceName
        ? qualifiedTemplateDefinition(
          definition.values.get(reference.namespaceName),
          reference.memberName
        )
        : definition.templates.get(reference.memberName);
      return callee
        ? {
            name: reference.displayName,
            sourceIdentity: templateDefinitionSourceIdentity(callee),
            fingerprint: calculateTemplateDefinitionFingerprint(callee, targetContext, memo, active)
          }
        : { name: reference.displayName, unresolved: true };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      sourceIdentity,
      namespace: definition.namespace,
      targetContext,
      definitionTarget: definition.definitionTargetFingerprint,
      outputMetadata: templateOutputMetadataFingerprint(definition.outputMetadata),
      outputSyntax: definition.node.outputSyntax,
      declaredOutputDialect: definition.node.declaredOutputDialect,
      parameters: definition.node.parameters,
      body: definition.node.body,
      callees
    }))
    .digest("hex");
  active.delete(sourceIdentity);
  memo.set(sourceIdentity, fingerprint);
  return fingerprint;
}

function templateDefinitionSourceIdentity(definition: RsglTemplateDefinition): string {
  return JSON.stringify([
    rsglPathKey(definition.fileName),
    definition.node.name?.text ?? definition.name,
    definition.node.range.start,
    definition.node.range.end
  ]);
}

interface TemplateCalleeReference {
  displayName: string;
  namespaceName?: string;
  memberName: string;
}

function collectTemplateCalleeReferences(node: TemplateDeclNode): TemplateCalleeReference[] {
  const references = new Map<string, TemplateCalleeReference>();
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === "UseDecl") {
      const expression = record.expression as {
        kind?: string;
        callee?: {
          kind?: string;
          name?: { text?: string };
          object?: { kind?: string; name?: { text?: string } };
          property?: { text?: string };
        };
      } | undefined;
      if (expression?.kind === "CallExpr" && expression.callee?.kind === "IdentifierExpr") {
        const name = expression.callee.name?.text;
        if (name) {
          references.set(name, { displayName: name, memberName: name });
        }
      } else if (
        expression?.kind === "CallExpr"
        && expression.callee?.kind === "MemberExpr"
        && expression.callee.object?.kind === "IdentifierExpr"
      ) {
        const namespaceName = expression.callee.object.name?.text;
        const memberName = expression.callee.property?.text;
        if (namespaceName && memberName) {
          const displayName = `${namespaceName}.${memberName}`;
          references.set(displayName, { displayName, namespaceName, memberName });
        }
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== "range" && key !== "fullRange") {
        visit(child);
      }
    }
  };
  visit(node.body);
  return [...references.values()];
}

function qualifiedTemplateDefinition(
  namespaceValue: EvaluationValue,
  memberName: string
): RsglTemplateDefinition | undefined {
  return isModuleNamespaceValue(namespaceValue)
    ? namespaceValue.resolveTemplate(memberName)
    : undefined;
}

function importedNamespaceName(record: RsglSemanticModel["imports"][number]): string | undefined {
  return record.namespaceName ?? record.node.namespaceName?.text;
}

function isLetDeclNode(node: unknown): node is LetDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "LetDecl");
}

function isTableDeclNode(node: unknown): node is TableDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "TableDecl");
}
