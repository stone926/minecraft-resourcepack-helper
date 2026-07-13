import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  LetDeclNode,
  TableDeclNode,
  TemplateDeclNode
} from "../parser";
import {
  createRsglExportMaps,
  RsglProgram,
  RsglSemanticModel,
  RsglSymbol
} from "../semantic";
import {
  EvaluationContext,
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
import type {
  ResolvedTemplateOutputConflict,
  ResolvedTemplateOutputMetadata
} from "../templateOutput";
import { templateOutputMetadataFingerprint } from "../templateOutput";
import { inferResolvedTemplateOutputMetadata } from "../semantic/templateOutputResolution";

export interface RsglModuleCompileEnvironment {
  fileName: string;
  namespace: string;
  importedValues: Map<string, EvaluationValue>;
  importedValueOrigins: Map<string, EvaluationOrigin>;
  importedValuePathOrigins: Map<string, EvaluationPathOrigin[]>;
  importedValueIssues: Map<string, EvaluationValueIssue[]>;
  importedTemplates: Map<string, RsglTemplateDefinition>;
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
  /** Frozen semantic/link failure that must stop dispatch before evaluation. */
  outputConflict?: ResolvedTemplateOutputConflict;
  /** Immutable-input fingerprint used only for dispatch-plan caching. */
  definitionFingerprint: string;
  definitionTargetFingerprint: string;
  fileName: string;
  namespace: string;
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
  baseDocumentLoader?: BaseDocumentLoader;
  globLoader?: RawGlobLoader;
  onDependency?: (dependency: CompileDependency) => void;
  /** Stable effective project configuration used by definition/dispatch fingerprints. */
  definitionFingerprintContext?: string;
}

export function createStandaloneCompileEnvironment(
  model: RsglSemanticModel,
  namespace: string,
  options: RsglCompileEnvironmentOptions = {}
): RsglModuleCompileEnvironment {
  const environment = createEmptyCompileEnvironment(model, namespace);
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
  const modelsByFile = new Map(program.models.map(model => [normalizeFileName(model.fileName), model]));
  const exportMaps = createRsglExportMaps(program.models, program.importGraph).maps;
  const environments = new Map<string, RsglModuleCompileEnvironment>();

  const createEnvironment = (model: RsglSemanticModel): RsglModuleCompileEnvironment => {
    const fileName = normalizeFileName(model.fileName);
    const cached = environments.get(fileName);
    if (cached) {
      return cached;
    }

    const environment = createEmptyCompileEnvironment(
      model,
      effectiveNamespace(model.namespace, configuration)
    );
    environments.set(fileName, environment);

    collectImportedEnvironmentBindings(environment, model, program, modelsByFile, createEnvironment);
    evaluateLocalEnvironmentValues(environment, model, options);
    collectLocalEnvironmentTemplates(environment, model);
    collectExportedEnvironmentBindings(environment, model, program, modelsByFile, exportMaps, createEnvironment);
    return environment;
  };

  for (const model of program.models) {
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
  outputMetadata: ResolvedTemplateOutputMetadata = inferResolvedTemplateOutputMetadata(node),
  definitionTargetFingerprint = "unresolved-target",
  definitionFingerprintContext = "unresolved-target",
  outputConflict?: ResolvedTemplateOutputConflict
): RsglTemplateDefinition {
  const definition: RsglTemplateDefinition = {
    name,
    node,
    outputMetadata,
    outputConflict,
    definitionFingerprint: "",
    definitionTargetFingerprint,
    fileName,
    namespace,
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

function createEmptyCompileEnvironment(model: RsglSemanticModel, namespace: string): RsglModuleCompileEnvironment {
  return {
    fileName: model.fileName,
    namespace,
    importedValues: new Map(),
    importedValueOrigins: new Map(),
    importedValuePathOrigins: new Map(),
    importedValueIssues: new Map(),
    importedTemplates: new Map(),
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
  if (model.exports.length === 0) {
    copyValueBindings(
      environment.exportedValues,
      environment.exportedValueOrigins,
      environment.exportedValuePathOrigins,
      environment.exportedValueIssues,
      environment.allValues,
      environment.allValueOrigins,
      environment.allValuePathOrigins,
      environment.allValueIssues
    );
    copyTemplates(environment.exportedTemplates, environment.allTemplates);
    return;
  }

  const semanticExports = exportMaps.get(normalizeFileName(model.fileName)) ?? new Map();
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
    valueOrigins: new Map(environment.importedValueOrigins),
    valuePathOrigins: new Map(environment.importedValuePathOrigins),
    valueIssues: new Map(environment.importedValueIssues),
    sourceFile: model.fileName,
    mappingReason: "direct",
    expansionStack: [],
    baseDocumentLoader: options.baseDocumentLoader,
    globLoader: options.globLoader,
    onDependency: options.onDependency
  };

  for (const statement of model.module.statements) {
    if (isLetDeclNode(statement) && statement.name) {
      const result = evaluateExpressionResult(statement.value, context);
      recordLocalEnvironmentValue(environment, context, statement.name.text, result, model.fileName);
    } else if (isTableDeclNode(statement) && statement.name) {
      const result = evaluateExpressionResult(statement.body, context);
      recordLocalEnvironmentValue(environment, context, statement.name.text, {
        ...result,
        value: normalizeJsonValue(result.value)
      }, model.fileName);
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
        ?? inferResolvedTemplateOutputMetadata(statement);
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
        signature?.templateOutputConflict
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
  const currentFile = normalizeFileName(model.fileName);
  const targetFile = program.importGraph.edges.find(edge => edge.from === currentFile && edge.source === source)?.to;
  return targetFile ? modelsByFile.get(normalizeFileName(targetFile)) : undefined;
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
  const callees = collectTemplateCalleeNames(definition.node)
    .map(name => {
      const callee = definition.templates.get(name);
      return callee
        ? {
            name,
            sourceIdentity: templateDefinitionSourceIdentity(callee),
            fingerprint: calculateTemplateDefinitionFingerprint(callee, targetContext, memo, active)
          }
        : { name, unresolved: true };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      sourceIdentity,
      namespace: definition.namespace,
      targetContext,
      definitionTarget: definition.definitionTargetFingerprint,
      outputMetadata: templateOutputMetadataFingerprint(definition.outputMetadata),
      outputConflict: definition.outputConflict?.evidence ?? null,
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
    normalizeFileName(definition.fileName),
    definition.node.name?.text ?? definition.name,
    definition.node.range.start,
    definition.node.range.end
  ]);
}

function collectTemplateCalleeNames(node: TemplateDeclNode): string[] {
  const names = new Set<string>();
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
        callee?: { kind?: string; name?: { text?: string } };
      } | undefined;
      if (expression?.kind === "CallExpr" && expression.callee?.kind === "IdentifierExpr") {
        const name = expression.callee.name?.text;
        if (name) {
          names.add(name);
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
  return [...names];
}

function normalizeFileName(fileName: string): string {
  return path.normalize(fileName);
}

function isLetDeclNode(node: unknown): node is LetDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "LetDecl");
}

function isTableDeclNode(node: unknown): node is TableDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "TableDecl");
}
