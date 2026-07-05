import * as path from "node:path";
import {
  FragmentDeclNode,
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
  RawJsonLoader,
  evaluateExpression
} from "./evaluate";
import { JsonValue } from "./ir";

export interface RsglModuleCompileEnvironment {
  fileName: string;
  namespace: string;
  importedValues: Map<string, EvaluationValue>;
  importedTemplates: Map<string, RsglTemplateDefinition>;
  importedFragments: Map<string, RsglFragmentDefinition>;
  localValues: Map<string, EvaluationValue>;
  allValues: Map<string, EvaluationValue>;
  allTemplates: Map<string, RsglTemplateDefinition>;
  allFragments: Map<string, RsglFragmentDefinition>;
  exportedValues: Map<string, EvaluationValue>;
  exportedTemplates: Map<string, RsglTemplateDefinition>;
  exportedFragments: Map<string, RsglFragmentDefinition>;
}

export interface RsglTemplateDefinition {
  name: string;
  node: TemplateDeclNode;
  fileName: string;
  namespace: string;
  values: Map<string, EvaluationValue>;
  templates: Map<string, RsglTemplateDefinition>;
  fragments: Map<string, RsglFragmentDefinition>;
}

export interface RsglFragmentDefinition {
  name: string;
  node: FragmentDeclNode;
  fileName: string;
  namespace: string;
  values: Map<string, EvaluationValue>;
  templates: Map<string, RsglTemplateDefinition>;
  fragments: Map<string, RsglFragmentDefinition>;
}

export interface RsglExternalValueDefinition {
  name: string;
  value: EvaluationValue;
}

export interface RsglCompileEnvironmentOptions {
  rawJsonLoader?: RawJsonLoader;
  globLoader?: RawGlobLoader;
}

export function createStandaloneCompileEnvironment(
  model: RsglSemanticModel,
  namespace: string,
  options: RsglCompileEnvironmentOptions = {}
): RsglModuleCompileEnvironment {
  const environment = createEmptyCompileEnvironment(model, namespace);
  evaluateLocalEnvironmentValues(environment, model, options);
  collectLocalEnvironmentTemplates(environment, model);
  collectLocalEnvironmentFragments(environment, model);
  return environment;
}

export function createProgramCompileEnvironments(
  program: RsglProgram,
  namespaceOverride: string | undefined,
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

    const environment = createEmptyCompileEnvironment(model, namespaceOverride ?? model.namespace ?? "minecraft");
    environments.set(fileName, environment);

    collectImportedEnvironmentBindings(environment, model, program, modelsByFile, createEnvironment);
    evaluateLocalEnvironmentValues(environment, model, options);
    collectLocalEnvironmentTemplates(environment, model);
    collectLocalEnvironmentFragments(environment, model);
    collectExportedEnvironmentBindings(environment, model, program, modelsByFile, exportMaps, createEnvironment);
    return environment;
  };

  for (const model of program.models) {
    createEnvironment(model);
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
  fragments: Map<string, RsglFragmentDefinition>
): RsglTemplateDefinition {
  return { name, node, fileName, namespace, values, templates, fragments };
}

export function createFragmentDefinition(
  name: string,
  node: FragmentDeclNode,
  fileName: string,
  namespace: string,
  values: Map<string, EvaluationValue>,
  templates: Map<string, RsglTemplateDefinition>,
  fragments: Map<string, RsglFragmentDefinition>
): RsglFragmentDefinition {
  return { name, node, fileName, namespace, values, templates, fragments };
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
    importedFragments: new Map(),
    localValues: new Map(),
    allValues: new Map(),
    allTemplates: new Map(),
    allFragments: new Map(),
    exportedValues: new Map(),
    exportedTemplates: new Map(),
    exportedFragments: new Map()
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
      copyFragments(environment.importedFragments, targetEnvironment.exportedFragments);
      copyFragments(environment.allFragments, targetEnvironment.exportedFragments);
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

      const fragment = targetEnvironment.exportedFragments.get(item.imported);
      if (fragment) {
        const aliasedFragment = aliasFragment(fragment, item.local);
        environment.importedFragments.set(item.local, aliasedFragment);
        environment.allFragments.set(item.local, aliasedFragment);
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
    copyFragments(environment.exportedFragments, environment.allFragments);
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
      const fragment = environment.allFragments.get(localName);
      if (fragment) {
        environment.exportedFragments.set(exportedName, aliasFragment(fragment, exportedName));
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
      copyFragments(environment.exportedFragments, targetEnvironment.exportedFragments);
    }
    for (const specifier of record.specifiers) {
      if (targetEnvironment.exportedValues.has(specifier.local)) {
        environment.exportedValues.set(specifier.exported, targetEnvironment.exportedValues.get(specifier.local));
      }
      const template = targetEnvironment.exportedTemplates.get(specifier.local);
      if (template) {
        environment.exportedTemplates.set(specifier.exported, aliasTemplate(template, specifier.exported));
      }
      const fragment = targetEnvironment.exportedFragments.get(specifier.local);
      if (fragment) {
        environment.exportedFragments.set(specifier.exported, aliasFragment(fragment, specifier.exported));
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
    rawJsonLoader: options.rawJsonLoader,
    globLoader: options.globLoader
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
      environment.allTemplates.set(statement.name.text, createTemplateDefinition(
        statement.name.text,
        statement,
        model.fileName,
        environment.namespace,
        environment.allValues,
        environment.allTemplates,
        environment.allFragments
      ));
    }
  }
}

function collectLocalEnvironmentFragments(
  environment: RsglModuleCompileEnvironment,
  model: RsglSemanticModel
): void {
  for (const statement of model.module.statements) {
    if (statement.kind === "FragmentDecl" && statement.name) {
      environment.allFragments.set(statement.name.text, createFragmentDefinition(
        statement.name.text,
        statement,
        model.fileName,
        environment.namespace,
        environment.allValues,
        environment.allTemplates,
        environment.allFragments
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

function aliasFragment(fragment: RsglFragmentDefinition, name: string): RsglFragmentDefinition {
  return fragment.name === name ? fragment : { ...fragment, name };
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

function copyFragments(target: Map<string, RsglFragmentDefinition>, source: Map<string, RsglFragmentDefinition>): void {
  for (const [name, fragment] of source) {
    if (!target.has(name)) {
      target.set(name, fragment);
    }
  }
}

function normalizeJsonValue(value: JsonValue | undefined): JsonValue {
  return value === undefined ? null : value;
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
