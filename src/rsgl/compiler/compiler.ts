import * as fs from "node:fs";
import * as path from "node:path";
import {
  BlockNode,
  ExprNode,
  ExportDeclNode,
  ForStmtNode,
  ImportDeclNode,
  LetDeclNode,
  MultipartBodyNode,
  MultipartSectionStatementNode,
  ResourceDeclNode,
  RsglModule,
  SugarDeclNode,
  TableDeclNode,
  TopLevelStatementNode,
  VariantBodyNode,
  VariantSectionStatementNode,
  parseRsgl
} from "../parser";
import {
  bindRsglModule,
  bindRsglProgram,
  RsglProgram,
  RsglSemanticModel,
  RsglSourceFile
} from "../semantic";
import {
  RsglExternalValueDefinition,
  RsglModuleCompileEnvironment,
  RsglTemplateDefinition,
  createProgramCompileEnvironments,
  createStandaloneCompileEnvironment,
  createTemplateDefinition,
  mapToExternalValues
} from "./environment";
import {
  childEvaluationContext,
  EvaluationContext,
  EvaluationValue,
  evaluateExpression
} from "./evaluate";
import { JsonValue, ResourceUnit, RsglCompileDiagnostic, RsglCompileResult } from "./ir";
import { createLoopBindings, createLoopContext as createEvaluationLoopContext } from "./looping";
import { mergeResourceUnits } from "./merge";
import { findResourceStatement, resourceBodyToObject } from "./resourceBody";
import { parseResourceId, resourceOutputPath } from "./resourceIds";
import {
  createCubeAllModel,
  createFenceBlockstate,
  createItemMapping,
  createSlabBlockstate,
  createStairsBlockstate,
  createWallBlockstate
} from "./templates";
import { RsglResourceValidationOptions, validateResourceUnits } from "./validation";

const namespacePattern = /^[a-z0-9_.-]+$/;

export interface RsglCompileOptions extends RsglResourceValidationOptions {
  fileName?: string;
  namespace?: string;
}

export interface RsglProgramCompileOptions extends RsglResourceValidationOptions {
  entryFileName?: string;
  namespace?: string;
}

export interface RsglFileLoadOptions {
  encoding?: BufferEncoding;
}

export interface RsglFileCompileOptions extends Omit<RsglProgramCompileOptions, "entryFileName">, RsglFileLoadOptions { }

interface RsglCompilerOptions {
  fileName: string;
  namespace: string;
  externalTemplates?: RsglTemplateDefinition[];
  externalValues?: RsglExternalValueDefinition[];
  environment?: RsglModuleCompileEnvironment;
}

type RsglCompileContext = EvaluationContext & {
  templates?: Map<string, RsglTemplateDefinition>;
};

export function compileRsglModule(module: RsglModule, options: RsglCompileOptions = {}): RsglCompileResult {
  const semanticModel = bindRsglModule(module, { fileName: options.fileName });
  const environment = createStandaloneCompileEnvironment(
    semanticModel,
    options.namespace ?? semanticModel.namespace ?? "minecraft"
  );
  const compiler = new RsglCompiler(module, {
    fileName: options.fileName ?? "<anonymous>",
    namespace: options.namespace ?? semanticModel.namespace ?? "minecraft",
    environment
  });
  const result = compiler.compile();
  const merged = mergeResourceUnits(result.units);
  return {
    units: merged.units,
    diagnostics: [
      ...semanticModel.diagnostics.map(diagnostic => ({ ...diagnostic })),
      ...result.diagnostics,
      ...merged.diagnostics,
      ...detectOutputConflicts(merged.units),
      ...validateResourceUnits(merged.units, options)
    ]
  };
}

export function compileRsglFile(entryFileName: string, options: RsglFileCompileOptions = {}): RsglCompileResult {
  const { encoding, ...compileOptions } = options;
  const resolvedEntryFileName = path.resolve(entryFileName);
  const files = loadRsglSourceFilesFromFile(resolvedEntryFileName, { encoding });
  return compileRsglProgram(files, { ...compileOptions, entryFileName: resolvedEntryFileName });
}

export function loadRsglSourceFilesFromFile(entryFileName: string, options: RsglFileLoadOptions = {}): RsglSourceFile[] {
  const encoding = options.encoding ?? "utf8";
  const files: RsglSourceFile[] = [];
  const visited = new Set<string>();

  const visit = (fileName: string): void => {
    const normalizedFileName = normalizeFileName(path.resolve(fileName));
    if (visited.has(normalizedFileName) || !fs.existsSync(normalizedFileName)) {
      return;
    }

    visited.add(normalizedFileName);
    const module = parseRsgl(fs.readFileSync(normalizedFileName, encoding));
    files.push({ fileName: normalizedFileName, module });

    for (const source of collectRelativeImportSources(module)) {
      visit(path.resolve(path.dirname(normalizedFileName), source));
    }
  };

  visit(entryFileName);
  return files;
}

export function compileRsglProgram(files: RsglSourceFile[], options: RsglProgramCompileOptions = {}): RsglCompileResult {
  const program = bindRsglProgram(files);
  const environments = createProgramCompileEnvironments(program, options.namespace);
  const selectedModels = selectProgramModels(program, options.entryFileName);
  const units: ResourceUnit[] = [];
  const diagnostics: RsglCompileDiagnostic[] = [
    ...program.diagnostics.map(diagnostic => ({ ...diagnostic }))
  ];

  if (options.entryFileName && selectedModels.length === 0) {
    diagnostics.push({
      code: "rsgl.compileMissingEntry",
      message: `RSGL entry file not found: ${options.entryFileName}.`,
      range: { start: 0, end: 1 },
      severity: "error"
    });
  }

  for (const model of selectedModels) {
    const environment = environments.get(normalizeFileName(model.fileName))
      ?? createStandaloneCompileEnvironment(model, options.namespace ?? model.namespace ?? "minecraft");
    const compiler = new RsglCompiler(model.module, {
      fileName: model.fileName,
      namespace: options.namespace ?? model.namespace ?? "minecraft",
      externalTemplates: Array.from(environment.importedTemplates.values()),
      externalValues: mapToExternalValues(environment.importedValues),
      environment
    });
    const result = compiler.compile();
    units.push(...result.units);
    diagnostics.push(...result.diagnostics);
  }

  const merged = mergeResourceUnits(units);
  diagnostics.push(
    ...merged.diagnostics,
    ...detectOutputConflicts(merged.units),
    ...validateResourceUnits(merged.units, options)
  );
  return { units: merged.units, diagnostics };
}

class RsglCompiler {
  private readonly units: ResourceUnit[] = [];
  private readonly diagnostics: RsglCompileDiagnostic[] = [];
  private readonly templates = new Map<string, RsglTemplateDefinition>();

  public constructor(
    private readonly module: RsglModule,
    private readonly options: RsglCompilerOptions
  ) { }

  public compile(): RsglCompileResult {
    for (const template of this.options.externalTemplates ?? []) {
      this.templates.set(template.name, template);
    }
    for (const statement of this.module.statements) {
      if (statement.kind === "TemplateDecl" && statement.name) {
        const template = this.options.environment?.allTemplates.get(statement.name.text)
          ?? createTemplateDefinition(
            statement.name.text,
            statement,
            this.options.fileName,
            this.options.namespace,
            new Map(),
            this.templates
          );
        this.templates.set(statement.name.text, template);
      }
    }
    const context = this.createRootContext();
    for (const statement of this.module.statements) {
      this.compileStatement(statement, context);
    }
    return { units: this.units, diagnostics: this.diagnostics };
  }

  private compileStatement(statement: TopLevelStatementNode, context: RsglCompileContext): void {
    if (statement.kind === "ResourceDecl") {
      this.compileResourceDecl(statement, context);
    } else if (statement.kind === "SugarDecl") {
      this.compileSugarDecl(statement, context);
    } else if (statement.kind === "LetDecl") {
      this.compileLetDecl(statement, context);
    } else if (statement.kind === "TableDecl") {
      this.compileTableDecl(statement, context);
    } else if (statement.kind === "UseDecl") {
      this.compileUseDecl(statement.expression, context);
    } else if (statement.kind === "ForStmt") {
      this.compileForStmt(statement, context);
    } else if (statement.kind === "IfStmt") {
      if (evaluateExpression(statement.condition, context)) {
        if (statement.thenBody.kind === "Block") {
          this.compileBlock(statement.thenBody, context);
        }
      } else if (statement.elseBody) {
        if (statement.elseBody.kind === "Block") {
          this.compileBlock(statement.elseBody, context);
        }
      }
    }
  }

  private compileResourceDecl(statement: ResourceDeclNode, context: RsglCompileContext): void {
    if (statement.resourceKind === "model") {
      this.pushUnit(this.compileModel(statement, context));
    } else if (statement.resourceKind === "item") {
      this.pushUnit(this.compileItem(statement, context));
    } else if (statement.resourceKind === "blockstate") {
      this.pushUnit(this.compileBlockstate(statement, context));
    } else if (statement.resourceKind === "atlas" || statement.resourceKind === "particles" || statement.resourceKind === "equipment") {
      this.pushUnit(this.compileGenericJsonResource(statement, context));
    } else if (statement.resourceKind === "pack") {
      this.pushUnit(this.compilePack(statement, context));
    } else if (statement.resourceKind === "lang") {
      this.pushUnit(this.compileLang(statement, context));
    } else if (statement.resourceKind === "sounds") {
      this.pushUnit(this.compileSounds(statement, context));
    } else if (statement.resourceKind === "mcmeta") {
      this.pushUnit(this.compileMcmeta(statement, context));
    }
  }

  private compileModel(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    if (!idValue) {
      this.error("rsgl.compileMissingResourceId", "Model declaration requires a static id.", statement.range);
      return null;
    }
    const subtype = statement.subtype?.text ?? "block";
    const id = parseResourceId(idValue, context.namespace);
    if (!id) {
      this.error("rsgl.compileInvalidResourceId", `Invalid model id '${idValue}'.`, statement.id?.range ?? statement.range);
      return null;
    }
    const modelId = { namespace: id.namespace, path: `${subtype}/${id.path}` };
    const outputPath = resourceOutputPath("model", modelId);
    return {
      id: modelId,
      kind: "model",
      outputPath,
      content: this.resourceBodyToObject(statement.body, context),
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(outputPath, statement, context)
    };
  }

  private compileItem(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    const id = idValue ? parseResourceId(idValue, context.namespace) : null;
    if (!id || !statement.id) {
      this.error("rsgl.compileMissingResourceId", "Item declaration requires a static id.", statement.range);
      return null;
    }
    const body = this.resourceBodyToObject(statement.body, context);
    const model = typeof body.model === "string"
      ? { type: "minecraft:model", model: body.model }
      : body.model;
    const outputPath = resourceOutputPath("item", id);
    return {
      id,
      kind: "item",
      outputPath,
      content: { ...body, model: normalizeJsonValue(model) },
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(outputPath, statement, context)
    };
  }

  private compileBlockstate(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    const id = idValue ? parseResourceId(idValue, context.namespace) : null;
    if (!id || !statement.id) {
      this.error("rsgl.compileMissingResourceId", "Blockstate declaration requires a static id.", statement.range);
      return null;
    }
    const variants = findResourceStatement(statement.body, "VariantsSection");
    const multipart = findResourceStatement(statement.body, "MultipartSection");
    const content: Record<string, JsonValue> = {};
    if (variants?.kind === "VariantsSection") {
      content.variants = this.compileVariantEntries(variants.entries, context);
    }
    if (multipart?.kind === "MultipartSection") {
      content.multipart = this.compileMultipartEntries(multipart.entries, context);
    }
    const outputPath = resourceOutputPath("blockstate", id);
    return {
      id,
      kind: "blockstate",
      outputPath,
      content,
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(outputPath, statement, context)
    };
  }

  private compileVariantEntries(
    statements: VariantSectionStatementNode[],
    context: RsglCompileContext
  ): Record<string, JsonValue> {
    const entries: Record<string, JsonValue> = {};
    for (const statement of statements) {
      this.compileVariantStatement(statement, context, entries);
    }
    return entries;
  }

  private compileVariantBody(
    body: VariantBodyNode,
    context: RsglCompileContext,
    entries: Record<string, JsonValue>
  ): void {
    for (const statement of body.statements) {
      this.compileVariantStatement(statement, context, entries);
    }
  }

  private compileVariantStatement(
    statement: VariantSectionStatementNode,
    context: RsglCompileContext,
    entries: Record<string, JsonValue>
  ): void {
    if (statement.kind === "VariantEntry") {
      const state = this.variantKey(normalizeJsonValue(evaluateExpression(statement.state, context)));
      entries[state] = normalizeJsonValue(evaluateExpression(statement.value, context));
    } else if (statement.kind === "ForStmt") {
      const iterable = evaluateExpression(statement.iterable, context);
      if (!Array.isArray(iterable)) {
        this.error("rsgl.compileNonFiniteLoop", "for input must evaluate to a finite list.", statement.iterable.range);
        return;
      }
      if (statement.body.kind !== "VariantBody") {
        return;
      }
      for (const value of iterable) {
        const bindings = createLoopBindings(statement.bindings.map(binding => binding.text), value);
        this.compileVariantBody(statement.body, this.createLoopContext(context, bindings, statement.range), entries);
      }
    } else if (statement.kind === "IfStmt") {
      const body = evaluateExpression(statement.condition, context) ? statement.thenBody : statement.elseBody;
      if (body?.kind === "VariantBody") {
        this.compileVariantBody(body, context, entries);
      }
    }
  }

  private compileMultipartEntries(
    statements: MultipartSectionStatementNode[],
    context: RsglCompileContext
  ): JsonValue[] {
    const entries: JsonValue[] = [];
    for (const statement of statements) {
      this.compileMultipartStatement(statement, context, entries);
    }
    return entries;
  }

  private compileMultipartBody(
    body: MultipartBodyNode,
    context: RsglCompileContext,
    entries: JsonValue[]
  ): void {
    for (const statement of body.statements) {
      this.compileMultipartStatement(statement, context, entries);
    }
  }

  private compileMultipartStatement(
    statement: MultipartSectionStatementNode,
    context: RsglCompileContext,
    entries: JsonValue[]
  ): void {
    if (statement.kind === "MultipartEntry") {
      const value: Record<string, JsonValue> = {
        apply: normalizeJsonValue(evaluateExpression(statement.apply, context))
      };
      if (statement.when) {
        value.when = normalizeJsonValue(evaluateExpression(statement.when, context));
      }
      entries.push(value);
    } else if (statement.kind === "ForStmt") {
      const iterable = evaluateExpression(statement.iterable, context);
      if (!Array.isArray(iterable)) {
        this.error("rsgl.compileNonFiniteLoop", "for input must evaluate to a finite list.", statement.iterable.range);
        return;
      }
      if (statement.body.kind !== "MultipartBody") {
        return;
      }
      for (const value of iterable) {
        const bindings = createLoopBindings(statement.bindings.map(binding => binding.text), value);
        this.compileMultipartBody(statement.body, this.createLoopContext(context, bindings, statement.range), entries);
      }
    } else if (statement.kind === "IfStmt") {
      const body = evaluateExpression(statement.condition, context) ? statement.thenBody : statement.elseBody;
      if (body?.kind === "MultipartBody") {
        this.compileMultipartBody(body, context, entries);
      }
    }
  }

  private compileGenericJsonResource(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    const id = idValue ? parseResourceId(idValue, context.namespace) : null;
    if (!id || !statement.id) {
      this.error("rsgl.compileMissingResourceId", `${statement.resourceKind} declaration requires a static id.`, statement.range);
      return null;
    }
    const outputPath = resourceOutputPath(statement.resourceKind, id);
    return {
      id,
      kind: statement.resourceKind as ResourceUnit["kind"],
      outputPath,
      content: this.resourceBodyToObject(statement.body, context),
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(outputPath, statement, context)
    };
  }

  private compilePack(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit {
    const outputPath = "pack.mcmeta";
    const body = this.resourceBodyToObject(statement.body, context);
    const content = isJsonObject(body.pack) ? body : { pack: body };
    return {
      kind: "pack",
      outputPath,
      content,
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(outputPath, statement, context)
    };
  }

  private compileLang(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    const id = idValue ? parseResourceId(idValue, context.namespace) : null;
    if (!id || !statement.id) {
      this.error("rsgl.compileMissingResourceId", "Lang declaration requires a static locale id.", statement.range);
      return null;
    }
    const outputPath = resourceOutputPath("lang", id);
    return {
      id,
      kind: "lang",
      outputPath,
      content: this.resourceBodyToObject(statement.body, context),
      mergePolicy: { kind: "mergeObject" },
      sourceMap: this.sourceMap(outputPath, statement, context)
    };
  }

  private compileSounds(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const namespace = this.soundsNamespace(statement, context);
    if (!namespace) {
      this.error("rsgl.compileMissingResourceId", "Sounds declaration requires a namespace.", statement.range);
      return null;
    }
    const id = { namespace, path: "sounds" };
    const outputPath = `assets/${namespace}/sounds.json`;
    return {
      id,
      kind: "sounds",
      outputPath,
      content: this.resourceBodyToObject(statement.body, context),
      mergePolicy: { kind: "mergeObject" },
      sourceMap: this.sourceMap(outputPath, statement, context)
    };
  }

  private compileMcmeta(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    if (!idValue || !statement.id) {
      this.error("rsgl.compileMissingResourceId", "Mcmeta declaration requires a static target path.", statement.range);
      return null;
    }
    const target = this.mcmetaTarget(idValue, context.namespace);
    if (!target) {
      this.error("rsgl.compileInvalidResourceId", `Invalid mcmeta target '${idValue}'.`, statement.id.range);
      return null;
    }
    return {
      id: target.id,
      kind: "mcmeta",
      outputPath: target.outputPath,
      content: this.resourceBodyToObject(statement.body, context),
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(target.outputPath, statement, context)
    };
  }

  private compileSugarDecl(statement: SugarDeclNode, context: RsglCompileContext): void {
    if (statement.sugarKind === "conventionalBlockstate") {
      this.compileConventionalBlockstateSugar(statement, context);
    } else if (statement.sugarKind === "batchModel") {
      for (const entry of statement.entries) {
        this.pushUnit(createCubeAllModel(
          this.staticText(entry.id, context) ?? "",
          entry.target ? (this.staticText(entry.target, context) ?? undefined) : undefined,
          context.namespace,
          context.sourceFile ?? this.options.fileName,
          entry.range,
          context.expansionStack ?? []
        ));
      }
    } else if (statement.sugarKind === "batchItemModel") {
      for (const entry of statement.entries) {
        this.pushUnit(createItemMapping(
          this.staticText(entry.id, context) ?? "",
          entry.target ? (this.staticText(entry.target, context) ?? undefined) : undefined,
          context.namespace,
          context.sourceFile ?? this.options.fileName,
          entry.range,
          context.expansionStack ?? []
        ));
      }
    }
  }

  private compileConventionalBlockstateSugar(statement: SugarDeclNode, context: RsglCompileContext): void {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    if (!idValue) {
      this.error("rsgl.compileMissingResourceId", "Blockstate sugar requires a static id.", statement.range);
      return;
    }
    if (statement.sugarName.text === "stairs") {
      this.pushUnit(createStairsBlockstate(idValue, context.namespace, context.sourceFile ?? this.options.fileName, statement.range, context.expansionStack ?? []));
    } else if (statement.sugarName.text === "slab") {
      const double = statement.options.find(option => option.name.text === "double")?.value;
      if (!double) {
        this.error("rsgl.slabMissingDouble", "slab sugar requires an explicit double model.", statement.range);
        return;
      }
      this.pushUnit(createSlabBlockstate(idValue, this.staticText(double, context) ?? "", context.namespace, context.sourceFile ?? this.options.fileName, statement.range, context.expansionStack ?? []));
    } else if (statement.sugarName.text === "fence") {
      this.pushUnit(createFenceBlockstate(idValue, context.namespace, context.sourceFile ?? this.options.fileName, statement.range, context.expansionStack ?? []));
    } else if (statement.sugarName.text === "wall") {
      this.pushUnit(createWallBlockstate(idValue, context.namespace, context.sourceFile ?? this.options.fileName, statement.range, context.expansionStack ?? []));
    }
  }

  private variantKey(value: JsonValue): string {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return "";
    }
    return Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${key}=${String(item)}`)
      .join(",");
  }

  private compileLetDecl(statement: LetDeclNode, context: RsglCompileContext): void {
    if (statement.name) {
      context.variables.set(statement.name.text, evaluateExpression(statement.value, context));
    }
  }

  private compileTableDecl(statement: TableDeclNode, context: RsglCompileContext): void {
    if (statement.name) {
      context.variables.set(statement.name.text, normalizeJsonValue(evaluateExpression(statement.body, context)));
    }
  }

  private compileUseDecl(expression: ExprNode, context: RsglCompileContext): void {
    if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
      return;
    }
    const template = (context.templates ?? this.templates).get(expression.callee.name.text);
    if (!template) {
      return;
    }
    const templateBaseContext = this.createTemplateBaseContext(template);
    const values: Record<string, EvaluationValue> = {};
    const positional = expression.args.filter(arg => !arg.name);
    for (const [index, parameter] of template.node.parameters.entries()) {
      const name = parameter.name?.text;
      if (!name) {
        continue;
      }
      const arg = expression.args.find(item => item.name?.text === name) ?? positional[index];
      if (arg) {
        values[name] = evaluateExpression(arg.value, context);
      } else if (parameter.defaultValue) {
        values[name] = evaluateExpression(parameter.defaultValue, this.createChildContext(templateBaseContext, values));
      } else {
        this.error("rsgl.compileMissingArgument", `Missing template argument '${name}'.`, expression.range);
      }
    }
    const templateContext = this.createChildContext(templateBaseContext, values, {
      sourceFile: template.fileName,
      mappingReason: "template",
      expansionStack: [
        ...(context.expansionStack ?? []),
        { label: `use ${expression.callee.name.text}`, sourceRange: expression.range }
      ]
    });
    this.compileBlock(template.node.body, templateContext);
  }

  private compileForStmt(statement: ForStmtNode, context: RsglCompileContext): void {
    const iterable = evaluateExpression(statement.iterable, context);
    const values = Array.isArray(iterable) ? iterable : [];
    if (!Array.isArray(iterable)) {
      this.error("rsgl.compileNonFiniteLoop", "for input must evaluate to a finite list.", statement.iterable.range);
      return;
    }
    if (statement.body.kind !== "Block") {
      return;
    }
    for (const value of values) {
      const bindings = createLoopBindings(statement.bindings.map(binding => binding.text), value);
      this.compileBlock(statement.body, this.createLoopContext(context, bindings, statement.range));
    }
  }

  private compileBlock(body: BlockNode, context: RsglCompileContext): void {
    for (const statement of body.statements) {
      this.compileStatement(statement, context);
    }
  }

  private staticText(expression: ExprNode, context: RsglCompileContext): string | null {
    const value = evaluateExpression(expression, context);
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : null;
  }

  private soundsNamespace(statement: ResourceDeclNode, context: RsglCompileContext): string | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    if (!idValue) {
      return null;
    }
    if (namespacePattern.test(idValue)) {
      return idValue;
    }
    const id = parseResourceId(idValue, context.namespace);
    return id?.namespace ?? null;
  }

  private mcmetaTarget(value: string, namespace: string): { id?: { namespace: string; path: string }; outputPath: string } | null {
    const normalizedPath = value.replace(/\\/g, "/");
    if (normalizedPath.startsWith("assets/")) {
      return { outputPath: normalizeMcmetaOutputPath(normalizedPath) };
    }

    const id = parseResourceId(value, namespace);
    if (!id) {
      return null;
    }
    const texturePath = id.path.startsWith("textures/")
      ? id.path.slice("textures/".length)
      : id.path;
    const pngPath = texturePath.endsWith(".png") || texturePath.endsWith(".png.mcmeta")
      ? texturePath
      : `${texturePath}.png`;
    return {
      id,
      outputPath: normalizeMcmetaOutputPath(`assets/${id.namespace}/textures/${pngPath}`)
    };
  }

  private createRootContext(): RsglCompileContext {
    return {
      namespace: this.options.namespace,
      variables: new Map<string, EvaluationValue>(
        (this.options.externalValues ?? []).map(item => [item.name, item.value])
      ),
      sourceFile: this.options.fileName,
      mappingReason: "direct",
      expansionStack: [],
      templates: this.templates
    };
  }

  private createTemplateBaseContext(template: RsglTemplateDefinition): RsglCompileContext {
    return {
      namespace: template.namespace,
      variables: new Map(template.values),
      sourceFile: template.fileName,
      mappingReason: "template",
      expansionStack: [],
      templates: template.templates
    };
  }

  private createChildContext(
    context: RsglCompileContext,
    values: Record<string, EvaluationValue>,
    metadata: Partial<Pick<EvaluationContext, "sourceFile" | "mappingReason" | "expansionStack">> = {}
  ): RsglCompileContext {
    return {
      ...childEvaluationContext(context, values, metadata),
      templates: context.templates
    };
  }

  private createLoopContext(
    context: RsglCompileContext,
    bindings: Record<string, EvaluationValue>,
    sourceRange: { start: number; end: number }
  ): RsglCompileContext {
    return {
      ...createEvaluationLoopContext(context, bindings, sourceRange),
      templates: context.templates
    };
  }

  private pushUnit(unit: ResourceUnit | null): void {
    if (unit) {
      this.units.push(unit);
    }
  }

  private resourceBodyToObject(body: ResourceDeclNode["body"], context: RsglCompileContext): Record<string, JsonValue> {
    return resourceBodyToObject(body, context, {
      onError: (code, message, range) => this.error(code, message, range)
    });
  }

  private sourceMap(outputPath: string, node: { range: { start: number; end: number } }, context: RsglCompileContext) {
    return {
      generatedFile: outputPath,
      mappings: [{
        generatedPath: "",
        sourceFile: context.sourceFile ?? this.options.fileName,
        sourceRange: node.range,
        reason: context.mappingReason ?? "direct",
        expansionStack: context.expansionStack ?? []
      }]
    };
  }

  private error(code: string, message: string, range: { start: number; end: number }): void {
    this.diagnostics.push({ code, message, range, severity: "error" });
  }
}

function normalizeJsonValue(value: JsonValue | undefined): JsonValue {
  return value === undefined ? null : value;
}

function normalizeMcmetaOutputPath(outputPath: string): string {
  return outputPath.endsWith(".mcmeta") ? outputPath : `${outputPath}.mcmeta`;
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function selectProgramModels(program: RsglProgram, entryFileName: string | undefined): RsglSemanticModel[] {
  if (!entryFileName) {
    return program.models;
  }
  const normalizedEntry = normalizeFileName(entryFileName);
  return program.models.filter(model => normalizeFileName(model.fileName) === normalizedEntry);
}

function detectOutputConflicts(units: ResourceUnit[]): RsglCompileDiagnostic[] {
  const diagnostics: RsglCompileDiagnostic[] = [];
  const seen = new Map<string, ResourceUnit>();
  for (const unit of units) {
    const existing = seen.get(unit.outputPath);
    if (existing) {
      diagnostics.push({
        code: "rsgl.outputConflict",
        message: `Multiple RSGL resources emit ${unit.outputPath}.`,
        range: unit.sourceMap.mappings[0]?.sourceRange ?? { start: 0, end: 1 },
        severity: "error"
      });
    } else {
      seen.set(unit.outputPath, unit);
    }
  }
  return diagnostics;
}

function collectRelativeImportSources(module: RsglModule): string[] {
  return module.statements
    .filter((statement): statement is ImportDeclNode | ExportDeclNode => isImportDeclNode(statement) || isExportDeclNode(statement))
    .map(statement => statement.source?.value)
    .filter((source): source is string => Boolean(source && source.startsWith(".")));
}

function normalizeFileName(fileName: string): string {
  return path.normalize(fileName);
}

function isImportDeclNode(node: unknown): node is ImportDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "ImportDecl");
}

function isExportDeclNode(node: unknown): node is ExportDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "ExportDecl");
}
