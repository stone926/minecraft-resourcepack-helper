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
  EvaluationValue,
  RawGlobLoader,
  evaluateExpression
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
  importedTemplates: Map<string, RsglTemplateDefinition>;
  localValues: Map<string, EvaluationValue>;
  allValues: Map<string, EvaluationValue>;
  allTemplates: Map<string, RsglTemplateDefinition>;
  exportedValues: Map<string, EvaluationValue>;
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
  templates: Map<string, RsglTemplateDefinition>;
}

export interface RsglExternalValueDefinition {
  name: string;
  value: EvaluationValue;
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

export function mapToExternalValues(values: Map<string, EvaluationValue>): RsglExternalValueDefinition[] {
  return Array.from(values, ([name, value]) => ({ name, value }));
}

function createEmptyCompileEnvironment(model: RsglSemanticModel, namespace: string): RsglModuleCompileEnvironment {
  return {
    fileName: model.fileName,
    namespace,
    importedValues: new Map(),
    importedTemplates: new Map(),
    localValues: new Map(),
    allValues: new Map(),
    allTemplates: new Map(),
    exportedValues: new Map(),
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
      copyValues(environment.importedValues, targetEnvironment.exportedValues);
      copyValues(environment.allValues, targetEnvironment.exportedValues);
      copyTemplates(environment.importedTemplates, targetEnvironment.exportedTemplates);
      copyTemplates(environment.allTemplates, targetEnvironment.exportedTemplates);
    }
    for (const item of record.namedImports) {
      if (targetEnvironment.exportedValues.has(item.imported)) {
        const value = targetEnvironment.exportedValues.get(item.imported);
        environment.importedValues.set(item.local, value);
        environment.allValues.set(item.local, value);
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
    copyValues(environment.exportedValues, environment.allValues);
    copyTemplates(environment.exportedTemplates, environment.allTemplates);
    return;
  }

  const semanticExports = exportMaps.get(normalizeFileName(model.fileName)) ?? new Map();
  for (const [exportedName, symbol] of semanticExports) {
    if (symbol && typeof symbol === "object" && "name" in symbol) {
      const localName = String(symbol.name);
      if (environment.allValues.has(localName)) {
        environment.exportedValues.set(exportedName, environment.allValues.get(localName));
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
      copyValues(environment.exportedValues, targetEnvironment.exportedValues);
      copyTemplates(environment.exportedTemplates, targetEnvironment.exportedTemplates);
    }
    for (const specifier of record.specifiers) {
      if (targetEnvironment.exportedValues.has(specifier.local)) {
        environment.exportedValues.set(specifier.exported, targetEnvironment.exportedValues.get(specifier.local));
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
    sourceFile: model.fileName,
    mappingReason: "direct",
    expansionStack: [],
    baseDocumentLoader: options.baseDocumentLoader,
    globLoader: options.globLoader,
    onDependency: options.onDependency
  };

  for (const statement of model.module.statements) {
    if (isLetDeclNode(statement) && statement.name) {
      const value = evaluateExpression(statement.value, context);
      environment.localValues.set(statement.name.text, value);
      environment.allValues.set(statement.name.text, value);
      context.variables.set(statement.name.text, value);
    } else if (isTableDeclNode(statement) && statement.name) {
      const value = normalizeJsonValue(evaluateExpression(statement.body, context));
      environment.localValues.set(statement.name.text, value);
      environment.allValues.set(statement.name.text, value);
      context.variables.set(statement.name.text, value);
    }
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
      environment.allTemplates.set(statement.name.text, createTemplateDefinition(
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
      ));
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

function copyValues(target: Map<string, EvaluationValue>, source: Map<string, EvaluationValue>): void {
  for (const [name, value] of source) {
    if (!target.has(name)) {
      target.set(name, value);
    }
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
