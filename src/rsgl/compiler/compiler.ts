import {
  BlockNode,
  ExprNode,
  LetDeclNode,
  ResourceDeclNode,
  RsglModule,
  SugarDeclNode,
  TemplateDeclNode,
  TopLevelStatementNode
} from "../parser";
import { bindRsglModule } from "../semantic";
import {
  childEvaluationContext,
  EvaluationContext,
  EvaluationValue,
  evaluateExpression,
  findResourceStatement,
  resourceBodyToObject
} from "./evaluate";
import { JsonValue, ResourceUnit, RsglCompileDiagnostic, RsglCompileResult } from "./ir";
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

export interface RsglCompileOptions extends RsglResourceValidationOptions {
  fileName?: string;
  namespace?: string;
}

interface RsglCompilerOptions {
  fileName: string;
  namespace: string;
}

export function compileRsglModule(module: RsglModule, options: RsglCompileOptions = {}): RsglCompileResult {
  const semanticModel = bindRsglModule(module, { fileName: options.fileName });
  const compiler = new RsglCompiler(module, {
    fileName: options.fileName ?? "<anonymous>",
    namespace: options.namespace ?? semanticModel.namespace ?? "minecraft"
  });
  const result = compiler.compile();
  return {
    units: result.units,
    diagnostics: [
      ...semanticModel.diagnostics.map(diagnostic => ({ ...diagnostic })),
      ...result.diagnostics,
      ...validateResourceUnits(result.units, options)
    ]
  };
}

class RsglCompiler {
  private readonly units: ResourceUnit[] = [];
  private readonly diagnostics: RsglCompileDiagnostic[] = [];
  private readonly templates = new Map<string, TemplateDeclNode>();

  public constructor(
    private readonly module: RsglModule,
    private readonly options: RsglCompilerOptions
  ) { }

  public compile(): RsglCompileResult {
    for (const statement of this.module.statements) {
      if (statement.kind === "TemplateDecl" && statement.name) {
        this.templates.set(statement.name.text, statement);
      }
    }
    const context = this.createRootContext();
    for (const statement of this.module.statements) {
      this.compileStatement(statement, context);
    }
    this.detectOutputConflicts();
    return { units: this.units, diagnostics: this.diagnostics };
  }

  private compileStatement(statement: TopLevelStatementNode, context: EvaluationContext): void {
    if (statement.kind === "ResourceDecl") {
      this.compileResourceDecl(statement, context);
    } else if (statement.kind === "SugarDecl") {
      this.compileSugarDecl(statement, context);
    } else if (statement.kind === "LetDecl") {
      this.compileLetDecl(statement, context);
    } else if (statement.kind === "UseDecl") {
      this.compileUseDecl(statement.expression, context);
    } else if (statement.kind === "ForStmt") {
      this.compileForStmt(statement, context);
    } else if (statement.kind === "IfStmt") {
      if (evaluateExpression(statement.condition, context)) {
        this.compileBlock(statement.thenBody as BlockNode, context);
      } else if (statement.elseBody) {
        this.compileBlock(statement.elseBody as BlockNode, context);
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
      content: resourceBodyToObject(statement.body, context),
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(outputPath, statement, "direct")
    };
  }

  private compileItem(statement: ResourceDeclNode, context: EvaluationContext): ResourceUnit | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
    const id = idValue ? parseResourceId(idValue, this.options.namespace) : null;
    if (!id || !statement.id) {
      this.error("rsgl.compileMissingResourceId", "Item declaration requires a static id.", statement.range);
      return null;
    }
    const body = resourceBodyToObject(statement.body, context);
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
      sourceMap: this.sourceMap(outputPath, statement, "direct")
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
      const entries: Record<string, JsonValue> = {};
      for (const entry of variants.entries) {
        const state = this.variantKey(normalizeJsonValue(evaluateExpression(entry.state, context)));
        entries[state] = normalizeJsonValue(evaluateExpression(entry.value, context));
      }
      content.variants = entries;
    }
    if (multipart?.kind === "MultipartSection") {
      content.multipart = multipart.entries.map(entry => {
        const value: Record<string, JsonValue> = {
          apply: normalizeJsonValue(evaluateExpression(entry.apply, context))
        };
        if (entry.when) {
          value.when = normalizeJsonValue(evaluateExpression(entry.when, context));
        }
        return value;
      });
    }
    const outputPath = resourceOutputPath("blockstate", id);
    return {
      id,
      kind: "blockstate",
      outputPath,
      content,
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(outputPath, statement, "direct")
    };
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
      content: resourceBodyToObject(statement.body, context),
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(outputPath, statement, "direct")
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
          this.options.fileName,
          entry.range
        ));
      }
    } else if (statement.sugarKind === "batchItemModel") {
      for (const entry of statement.entries) {
        this.pushUnit(createItemMapping(
          this.staticText(entry.id, context) ?? "",
          entry.target ? (this.staticText(entry.target, context) ?? undefined) : undefined,
          this.options.namespace,
          this.options.fileName,
          entry.range
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
      this.pushUnit(createStairsBlockstate(idValue, this.options.namespace, this.options.fileName, statement.range));
    } else if (statement.sugarName.text === "slab") {
      const double = statement.options.find(option => option.name.text === "double")?.value;
      if (!double) {
        this.error("rsgl.slabMissingDouble", "slab sugar requires an explicit double model.", statement.range);
        return;
      }
      this.pushUnit(createSlabBlockstate(idValue, this.staticText(double, context) ?? "", this.options.namespace, this.options.fileName, statement.range));
    } else if (statement.sugarName.text === "fence") {
      this.pushUnit(createFenceBlockstate(idValue, this.options.namespace, this.options.fileName, statement.range));
    } else if (statement.sugarName.text === "wall") {
      this.pushUnit(createWallBlockstate(idValue, this.options.namespace, this.options.fileName, statement.range));
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
    for (const [index, parameter] of template.parameters.entries()) {
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
    this.compileBlock(template.body, childEvaluationContext(context, values));
  }

  private compileForStmt(statement: Extract<TopLevelStatementNode, { kind: "ForStmt" }>, context: EvaluationContext): void {
    const iterable = evaluateExpression(statement.iterable, context);
    const values = Array.isArray(iterable) ? iterable : [];
    if (!Array.isArray(iterable)) {
      this.error("rsgl.compileNonFiniteLoop", "for input must evaluate to a finite list.", statement.iterable.range);
      return;
    }
    for (const value of values) {
      const bindings: Record<string, EvaluationValue> = {};
      if (statement.bindings.length <= 1) {
        const name = statement.bindings[0]?.text;
        if (name) {
          bindings[name] = value;
        }
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        const entries = Object.entries(value as Record<string, JsonValue>);
        statement.bindings.forEach((binding, index) => {
          bindings[binding.text] = entries[index]?.[1];
        });
      }
      this.compileBlock(statement.body as BlockNode, childEvaluationContext(context, bindings));
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

  private createRootContext(): EvaluationContext {
    return {
      namespace: this.options.namespace,
      variables: new Map<string, EvaluationValue>()
    };
  }

  private pushUnit(unit: ResourceUnit | null): void {
    if (unit) {
      this.units.push(unit);
    }
  }

  private detectOutputConflicts(): void {
    const seen = new Map<string, ResourceUnit>();
    for (const unit of this.units) {
      const existing = seen.get(unit.outputPath);
      if (existing) {
        this.error("rsgl.outputConflict", `Multiple RSGL resources emit ${unit.outputPath}.`, unit.sourceMap.mappings[0].sourceRange);
      } else {
        seen.set(unit.outputPath, unit);
      }
    }
  }

  private sourceMap(outputPath: string, node: { range: { start: number; end: number } }, reason: "direct" | "builtin") {
    return {
      generatedFile: outputPath,
      mappings: [{
        generatedPath: "",
        sourceFile: this.options.fileName,
        sourceRange: node.range,
        reason,
        expansionStack: []
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
