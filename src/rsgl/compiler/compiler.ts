import * as path from "node:path";
import {
  BlockNode,
  ExprNode,
  ForStmtNode,
  LetDeclNode,
  MultipartBodyNode,
  MultipartSectionStatementNode,
  ResourceDeclNode,
  RsglModule,
  SugarDeclNode,
  TableDeclNode,
  TemplateDeclNode,
  TopLevelStatementNode,
  VariantBodyNode,
  VariantSectionStatementNode
} from "../parser";
import {
  bindRsglModule,
  bindRsglProgram,
  RsglProgram,
  RsglSemanticModel,
  RsglSourceFile
} from "../semantic";
import {
  childEvaluationContext,
  EvaluationContext,
  EvaluationValue,
  evaluateExpression
} from "./evaluate";
import { JsonValue, ResourceUnit, RsglCompileDiagnostic, RsglCompileResult } from "./ir";
import { createLoopBindings, createLoopContext } from "./looping";
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

interface RsglCompilerOptions {
  fileName: string;
  namespace: string;
  externalTemplates?: RsglTemplateDefinition[];
  externalValues?: RsglExternalValueDefinition[];
}

interface RsglTemplateDefinition {
  name: string;
  node: TemplateDeclNode;
  fileName: string;
}

interface RsglExternalValueDefinition {
  name: string;
  value: EvaluationValue;
}

export function compileRsglModule(module: RsglModule, options: RsglCompileOptions = {}): RsglCompileResult {
  const semanticModel = bindRsglModule(module, { fileName: options.fileName });
  const compiler = new RsglCompiler(module, {
    fileName: options.fileName ?? "<anonymous>",
    namespace: options.namespace ?? semanticModel.namespace ?? "minecraft"
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

export function compileRsglProgram(files: RsglSourceFile[], options: RsglProgramCompileOptions = {}): RsglCompileResult {
  const program = bindRsglProgram(files);
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
    const compiler = new RsglCompiler(model.module, {
      fileName: model.fileName,
      namespace: options.namespace ?? model.namespace ?? "minecraft",
      externalTemplates: collectImportedTemplates(model, program),
      externalValues: collectImportedValues(model, program)
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
        this.templates.set(statement.name.text, {
          name: statement.name.text,
          node: statement,
          fileName: this.options.fileName
        });
      }
    }
    const context = this.createRootContext();
    for (const statement of this.module.statements) {
      this.compileStatement(statement, context);
    }
    return { units: this.units, diagnostics: this.diagnostics };
  }

  private compileStatement(statement: TopLevelStatementNode, context: EvaluationContext): void {
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

  private compileResourceDecl(statement: ResourceDeclNode, context: EvaluationContext): void {
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

  private compileModel(statement: ResourceDeclNode, context: EvaluationContext): ResourceUnit | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    if (!idValue) {
      this.error("rsgl.compileMissingResourceId", "Model declaration requires a static id.", statement.range);
      return null;
    }
    const subtype = statement.subtype?.text ?? "block";
    const id = parseResourceId(idValue, this.options.namespace);
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

  private compileItem(statement: ResourceDeclNode, context: EvaluationContext): ResourceUnit | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    const id = idValue ? parseResourceId(idValue, this.options.namespace) : null;
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

  private compileBlockstate(statement: ResourceDeclNode, context: EvaluationContext): ResourceUnit | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    const id = idValue ? parseResourceId(idValue, this.options.namespace) : null;
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
    context: EvaluationContext
  ): Record<string, JsonValue> {
    const entries: Record<string, JsonValue> = {};
    for (const statement of statements) {
      this.compileVariantStatement(statement, context, entries);
    }
    return entries;
  }

  private compileVariantBody(
    body: VariantBodyNode,
    context: EvaluationContext,
    entries: Record<string, JsonValue>
  ): void {
    for (const statement of body.statements) {
      this.compileVariantStatement(statement, context, entries);
    }
  }

  private compileVariantStatement(
    statement: VariantSectionStatementNode,
    context: EvaluationContext,
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
        this.compileVariantBody(statement.body, createLoopContext(context, bindings, statement.range), entries);
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
    context: EvaluationContext
  ): JsonValue[] {
    const entries: JsonValue[] = [];
    for (const statement of statements) {
      this.compileMultipartStatement(statement, context, entries);
    }
    return entries;
  }

  private compileMultipartBody(
    body: MultipartBodyNode,
    context: EvaluationContext,
    entries: JsonValue[]
  ): void {
    for (const statement of body.statements) {
      this.compileMultipartStatement(statement, context, entries);
    }
  }

  private compileMultipartStatement(
    statement: MultipartSectionStatementNode,
    context: EvaluationContext,
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
        this.compileMultipartBody(statement.body, createLoopContext(context, bindings, statement.range), entries);
      }
    } else if (statement.kind === "IfStmt") {
      const body = evaluateExpression(statement.condition, context) ? statement.thenBody : statement.elseBody;
      if (body?.kind === "MultipartBody") {
        this.compileMultipartBody(body, context, entries);
      }
    }
  }

  private compileGenericJsonResource(statement: ResourceDeclNode, context: EvaluationContext): ResourceUnit | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    const id = idValue ? parseResourceId(idValue, this.options.namespace) : null;
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

  private compilePack(statement: ResourceDeclNode, context: EvaluationContext): ResourceUnit {
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

  private compileLang(statement: ResourceDeclNode, context: EvaluationContext): ResourceUnit | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    const id = idValue ? parseResourceId(idValue, this.options.namespace) : null;
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

  private compileSounds(statement: ResourceDeclNode, context: EvaluationContext): ResourceUnit | null {
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

  private compileMcmeta(statement: ResourceDeclNode, context: EvaluationContext): ResourceUnit | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    if (!idValue || !statement.id) {
      this.error("rsgl.compileMissingResourceId", "Mcmeta declaration requires a static target path.", statement.range);
      return null;
    }
    const target = this.mcmetaTarget(idValue);
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

  private compileSugarDecl(statement: SugarDeclNode, context: EvaluationContext): void {
    if (statement.sugarKind === "conventionalBlockstate") {
      this.compileConventionalBlockstateSugar(statement, context);
    } else if (statement.sugarKind === "batchModel") {
      for (const entry of statement.entries) {
        this.pushUnit(createCubeAllModel(
          this.staticText(entry.id, context) ?? "",
          entry.target ? (this.staticText(entry.target, context) ?? undefined) : undefined,
          this.options.namespace,
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
          this.options.namespace,
          context.sourceFile ?? this.options.fileName,
          entry.range,
          context.expansionStack ?? []
        ));
      }
    }
  }

  private compileConventionalBlockstateSugar(statement: SugarDeclNode, context: EvaluationContext): void {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    if (!idValue) {
      this.error("rsgl.compileMissingResourceId", "Blockstate sugar requires a static id.", statement.range);
      return;
    }
    if (statement.sugarName.text === "stairs") {
      this.pushUnit(createStairsBlockstate(idValue, this.options.namespace, context.sourceFile ?? this.options.fileName, statement.range, context.expansionStack ?? []));
    } else if (statement.sugarName.text === "slab") {
      const double = statement.options.find(option => option.name.text === "double")?.value;
      if (!double) {
        this.error("rsgl.slabMissingDouble", "slab sugar requires an explicit double model.", statement.range);
        return;
      }
      this.pushUnit(createSlabBlockstate(idValue, this.staticText(double, context) ?? "", this.options.namespace, context.sourceFile ?? this.options.fileName, statement.range, context.expansionStack ?? []));
    } else if (statement.sugarName.text === "fence") {
      this.pushUnit(createFenceBlockstate(idValue, this.options.namespace, context.sourceFile ?? this.options.fileName, statement.range, context.expansionStack ?? []));
    } else if (statement.sugarName.text === "wall") {
      this.pushUnit(createWallBlockstate(idValue, this.options.namespace, context.sourceFile ?? this.options.fileName, statement.range, context.expansionStack ?? []));
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

  private compileLetDecl(statement: LetDeclNode, context: EvaluationContext): void {
    if (statement.name) {
      context.variables.set(statement.name.text, evaluateExpression(statement.value, context));
    }
  }

  private compileTableDecl(statement: TableDeclNode, context: EvaluationContext): void {
    if (statement.name) {
      context.variables.set(statement.name.text, normalizeJsonValue(evaluateExpression(statement.body, context)));
    }
  }

  private compileUseDecl(expression: ExprNode, context: EvaluationContext): void {
    if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
      return;
    }
    const template = this.templates.get(expression.callee.name.text);
    if (!template) {
      return;
    }
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
        values[name] = evaluateExpression(parameter.defaultValue, childEvaluationContext(context, values));
      } else {
        this.error("rsgl.compileMissingArgument", `Missing template argument '${name}'.`, expression.range);
      }
    }
    const templateContext = childEvaluationContext(context, values, {
      sourceFile: template.fileName,
      mappingReason: "template",
      expansionStack: [
        ...(context.expansionStack ?? []),
        { label: `use ${expression.callee.name.text}`, sourceRange: expression.range }
      ]
    });
    this.compileBlock(template.node.body, templateContext);
  }

  private compileForStmt(statement: ForStmtNode, context: EvaluationContext): void {
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
      this.compileBlock(statement.body, createLoopContext(context, bindings, statement.range));
    }
  }

  private compileBlock(body: BlockNode, context: EvaluationContext): void {
    for (const statement of body.statements) {
      this.compileStatement(statement, context);
    }
  }

  private staticText(expression: ExprNode, context: EvaluationContext): string | null {
    const value = evaluateExpression(expression, context);
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : null;
  }

  private soundsNamespace(statement: ResourceDeclNode, context: EvaluationContext): string | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    if (!idValue) {
      return null;
    }
    if (namespacePattern.test(idValue)) {
      return idValue;
    }
    const id = parseResourceId(idValue, this.options.namespace);
    return id?.namespace ?? null;
  }

  private mcmetaTarget(value: string): { id?: { namespace: string; path: string }; outputPath: string } | null {
    const normalizedPath = value.replace(/\\/g, "/");
    if (normalizedPath.startsWith("assets/")) {
      return { outputPath: normalizeMcmetaOutputPath(normalizedPath) };
    }

    const id = parseResourceId(value, this.options.namespace);
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

  private createRootContext(): EvaluationContext {
    return {
      namespace: this.options.namespace,
      variables: new Map<string, EvaluationValue>(
        (this.options.externalValues ?? []).map(item => [item.name, item.value])
      ),
      sourceFile: this.options.fileName,
      mappingReason: "direct",
      expansionStack: []
    };
  }

  private pushUnit(unit: ResourceUnit | null): void {
    if (unit) {
      this.units.push(unit);
    }
  }

  private resourceBodyToObject(body: ResourceDeclNode["body"], context: EvaluationContext): Record<string, JsonValue> {
    return resourceBodyToObject(body, context, {
      onError: (code, message, range) => this.error(code, message, range)
    });
  }

  private sourceMap(outputPath: string, node: { range: { start: number; end: number } }, context: EvaluationContext) {
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

function collectImportedTemplates(model: RsglSemanticModel, program: RsglProgram): RsglTemplateDefinition[] {
  const modelsByFile = new Map(program.models.map(item => [normalizeFileName(item.fileName), item]));
  const currentFile = normalizeFileName(model.fileName);
  const templates: RsglTemplateDefinition[] = [];

  for (const record of model.imports) {
    const targetFile = record.resolvedFileName
      ? normalizeFileName(record.resolvedFileName)
      : program.importGraph.edges.find(edge => edge.from === currentFile && edge.source === record.source)?.to;
    const targetModel = targetFile ? modelsByFile.get(normalizeFileName(targetFile)) : undefined;
    if (!targetModel) {
      continue;
    }

    for (const item of record.namedImports) {
      const exported = targetModel.symbols.find(symbol => symbol.name === item.imported);
      if (isTemplateDeclNode(exported?.node)) {
        templates.push({
          name: item.local,
          node: exported.node,
          fileName: targetModel.fileName
        });
      }
    }
  }

  return templates;
}

function collectImportedValues(model: RsglSemanticModel, program: RsglProgram): RsglExternalValueDefinition[] {
  const modelsByFile = new Map(program.models.map(item => [normalizeFileName(item.fileName), item]));
  const currentFile = normalizeFileName(model.fileName);
  const values: RsglExternalValueDefinition[] = [];

  for (const record of model.imports) {
    const targetFile = record.resolvedFileName
      ? normalizeFileName(record.resolvedFileName)
      : program.importGraph.edges.find(edge => edge.from === currentFile && edge.source === record.source)?.to;
    const targetModel = targetFile ? modelsByFile.get(normalizeFileName(targetFile)) : undefined;
    if (!targetModel) {
      continue;
    }

    const exportedValues = evaluateTopLevelValues(targetModel);
    for (const item of record.namedImports) {
      if (exportedValues.has(item.imported)) {
        values.push({ name: item.local, value: exportedValues.get(item.imported) });
      }
    }
  }

  return values;
}

function evaluateTopLevelValues(model: RsglSemanticModel): Map<string, EvaluationValue> {
  const context: EvaluationContext = {
    namespace: model.namespace ?? "minecraft",
    variables: new Map<string, EvaluationValue>(),
    sourceFile: model.fileName,
    mappingReason: "direct",
    expansionStack: []
  };
  for (const statement of model.module.statements) {
    if (isLetDeclNode(statement) && statement.name) {
      context.variables.set(statement.name.text, evaluateExpression(statement.value, context));
    } else if (isTableDeclNode(statement) && statement.name) {
      context.variables.set(statement.name.text, normalizeJsonValue(evaluateExpression(statement.body, context)));
    }
  }
  return context.variables;
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

function normalizeFileName(fileName: string): string {
  return path.normalize(fileName);
}

function isTemplateDeclNode(node: unknown): node is TemplateDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "TemplateDecl");
}

function isTableDeclNode(node: unknown): node is TableDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "TableDecl");
}

function isLetDeclNode(node: unknown): node is LetDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "LetDecl");
}
