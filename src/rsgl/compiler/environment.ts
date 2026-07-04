import * as path from "node:path";
import {
  LetDeclNode,
  TableDeclNode,
  TemplateDeclNode
} from "../parser";
import {
  RsglProgram,
  RsglSemanticModel
} from "../semantic";
import {
  EvaluationContext,
  EvaluationValue,
  evaluateExpression
} from "./evaluate";
import { JsonValue } from "./ir";

export interface RsglModuleCompileEnvironment {
  fileName: string;
  namespace: string;
  importedValues: Map<string, EvaluationValue>;
  importedTemplates: Map<string, RsglTemplateDefinition>;
  localValues: Map<string, EvaluationValue>;
  allValues: Map<string, EvaluationValue>;
  allTemplates: Map<string, RsglTemplateDefinition>;
}

export interface RsglTemplateDefinition {
  name: string;
  node: TemplateDeclNode;
  fileName: string;
  namespace: string;
  values: Map<string, EvaluationValue>;
  templates: Map<string, RsglTemplateDefinition>;
}

export interface RsglExternalValueDefinition {
  name: string;
  value: EvaluationValue;
}

export function createStandaloneCompileEnvironment(
  model: RsglSemanticModel,
  namespace: string
): RsglModuleCompileEnvironment {
  const environment = createEmptyCompileEnvironment(model, namespace);
  evaluateLocalEnvironmentValues(environment, model);
  collectLocalEnvironmentTemplates(environment, model);
  return environment;
}

export function createProgramCompileEnvironments(
  program: RsglProgram,
  namespaceOverride: string | undefined
): Map<string, RsglModuleCompileEnvironment> {
  const modelsByFile = new Map(program.models.map(model => [normalizeFileName(model.fileName), model]));
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
    evaluateLocalEnvironmentValues(environment, model);
    collectLocalEnvironmentTemplates(environment, model);
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
  templates: Map<string, RsglTemplateDefinition>
): RsglTemplateDefinition {
  return { name, node, fileName, namespace, values, templates };
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
    allTemplates: new Map()
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
    const targetModel = resolveImportTargetModel(model, record, program, modelsByFile);
    if (!targetModel) {
      continue;
    }

    const targetEnvironment = createEnvironment(targetModel);
    for (const item of record.namedImports) {
      if (targetEnvironment.allValues.has(item.imported)) {
        const value = targetEnvironment.allValues.get(item.imported);
        environment.importedValues.set(item.local, value);
        environment.allValues.set(item.local, value);
      }

      const template = targetEnvironment.allTemplates.get(item.imported);
      if (template) {
        const aliasedTemplate = aliasTemplate(template, item.local);
        environment.importedTemplates.set(item.local, aliasedTemplate);
        environment.allTemplates.set(item.local, aliasedTemplate);
      }
    }
  }
}

function evaluateLocalEnvironmentValues(
  environment: RsglModuleCompileEnvironment,
  model: RsglSemanticModel
): void {
  const context: EvaluationContext = {
    namespace: environment.namespace,
    variables: new Map(environment.importedValues),
    sourceFile: model.fileName,
    mappingReason: "direct",
    expansionStack: []
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
        environment.allTemplates
      ));
    }
  }
}

function resolveImportTargetModel(
  model: RsglSemanticModel,
  record: RsglSemanticModel["imports"][number],
  program: RsglProgram,
  modelsByFile: Map<string, RsglSemanticModel>
): RsglSemanticModel | undefined {
  const currentFile = normalizeFileName(model.fileName);
  const targetFile = record.resolvedFileName
    ? normalizeFileName(record.resolvedFileName)
    : program.importGraph.edges.find(edge => edge.from === currentFile && edge.source === record.source)?.to;
  return targetFile ? modelsByFile.get(normalizeFileName(targetFile)) : undefined;
}

function aliasTemplate(template: RsglTemplateDefinition, name: string): RsglTemplateDefinition {
  return template.name === name ? template : { ...template, name };
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
