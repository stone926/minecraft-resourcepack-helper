import {
  BlockNode,
  ExprNode,
  ExternDeclNode,
  ForStmtNode,
  LetDeclNode,
  ResourceDeclNode,
  ResourceStatementNode,
  RsglModule,
  TableDeclNode,
  TopLevelStatementNode
} from "../parser";
import { compileAtlasSpecialStatement } from "./atlasSugar";
import { BlockstateCompileOptions, compileBlockstateResource } from "./blockstateCompiler";
import { bindRsglProgram } from "../semantic";
import {
  RsglExternalValueDefinition,
  RsglModuleCompileEnvironment,
  RsglTemplateDefinition,
  createProgramCompileEnvironments,
  createTemplateDefinition
} from "./environment";
import { compileEquipmentLayerStatement } from "./equipmentSugar";
import {
  childEvaluationContext,
  EvaluationContext,
  EvaluationValue,
  RawGlobLoader,
  RawJsonLoader,
  evaluateExpression
} from "./evaluate";
import { compileItemSpecialStatement } from "./itemFragments";
import { JsonValue, ResourceUnit, RsglCompileDiagnostic, RsglCompileResult, RsglMapping } from "./ir";
import { compileJsonResourceUseFragment, JsonResourceFragmentKind } from "./jsonResourceFragments";
import { createLoopContext as createEvaluationLoopContext, forEachLoopContext } from "./looping";
import { compileModelGeometryStatement } from "./modelGeometryDsl";
import {
  compileOverlayDecl,
  compilePackResource,
  compilePackSpecialStatement,
  pushOverlayPackUnit,
  PackOverlayCompileOptions,
  RsglOverlayEntry
} from "./packOverlayCompiler";
import { ResourceBodyCompileOptions, ResourceBodyFragment, ResourceBodyMapping, ResourceBodySpecialResult, resourceBodyToObject } from "./resourceBody";
import { compileResourceDeclaration, ResourceDeclarationCompilerHost } from "./resourceCompiler";
import { parseResourceId } from "./resourceIds";
import { RsglTargetPackFormat } from "./target";
import {
  createTemplateExpansion,
  templateResourceBody,
  RsglCompileContext,
  TemplateExpansion,
  TemplateExpansionOptions
} from "./templateExpansion";
import { createExternalResource } from "./templates";
import { createRsglStdlibPreludeSourceFiles } from "../stdlib";
import {
  isItemModelStatement,
  normalizeFileName,
  normalizeJsonValue,
  staticText
} from "./compilerHelpers";

export {
  compileRsglDirectory,
  compileRsglFile,
  compileRsglModule,
  compileRsglProgram,
  loadRsglSourceFilesFromDirectory,
  loadRsglSourceFilesFromFile
} from "./compilePipeline";
export type {
  RsglCompileOptions,
  RsglDirectoryCompileOptions,
  RsglFileCompileOptions,
  RsglFileLoadOptions,
  RsglProgramCompileOptions
} from "./compilePipeline";

interface RsglCompilerOptions {
  fileName: string;
  namespace: string;
  stdlibTemplates?: RsglTemplateDefinition[];
  externalTemplates?: RsglTemplateDefinition[];
  externalValues?: RsglExternalValueDefinition[];
  environment?: RsglModuleCompileEnvironment;
  rawJsonLoader?: RawJsonLoader;
  globLoader?: RawGlobLoader;
  targetPackFormat?: RsglTargetPackFormat;
  stdlibRoot?: string;
}

export class RsglCompiler {
  private readonly units: ResourceUnit[] = [];
  private readonly diagnostics: RsglCompileDiagnostic[] = [];
  private readonly templates = new Map<string, RsglTemplateDefinition>();
  private readonly overlayEntries: RsglOverlayEntry[] = [];

  public constructor(
    private readonly module: RsglModule,
    private readonly options: RsglCompilerOptions
  ) { }

  public compile(): RsglCompileResult {
    for (const template of this.options.stdlibTemplates ?? createRsglStdlibPreludeTemplates(this.options.stdlibRoot)) {
      this.templates.set(template.name, template);
    }
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
    pushOverlayPackUnit(this.packOverlayOptions());
    return { units: this.units, diagnostics: this.diagnostics };
  }

  private compileStatement(statement: TopLevelStatementNode, context: RsglCompileContext): void {
    if (statement.kind === "ResourceDecl") {
      this.compileResourceDecl(statement, context);
    } else if (statement.kind === "ExternDecl") {
      this.compileExternDecl(statement, context);
    } else if (statement.kind === "LetDecl") {
      this.compileLetDecl(statement, context);
    } else if (statement.kind === "TableDecl") {
      this.compileTableDecl(statement, context);
    } else if (statement.kind === "UseDecl") {
      this.compileUseDecl(statement.expression, context);
    } else if (statement.kind === "OverlayDecl") {
      compileOverlayDecl(statement, context, this.packOverlayOptions());
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
    for (const unit of compileResourceDeclaration(statement, context, this.resourceDeclarationCompilerHost())) {
      this.pushUnit(unit);
    }
  }

  private resourceDeclarationCompilerHost(): ResourceDeclarationCompilerHost {
    return {
      fileName: this.options.fileName,
      compileBlockstate: (statement, context) =>
        compileBlockstateResource(statement, context, this.blockstateCompileOptions()),
      compilePack: (statement, context) =>
        compilePackResource(statement, context, this.packOverlayOptions()),
      compileBody: (body, context, fragmentKind) =>
        this.resourceBodyToObjectWithMappings(body, context, this.resourceBodyFragmentOptions(fragmentKind)),
      compileJsonBody: (body, context, fragmentKind) =>
        this.resourceBodyToObjectWithMappings(body, context, this.jsonResourceFragmentOptions(fragmentKind)),
      compileRawBody: (body, context) =>
        this.resourceBodyToObjectWithRawMappings(body, context, this.resourceBodyFragmentOptions()),
      onError: (code, message, range) => this.error(code, message, range),
      sourceMap: (outputPath, node, context, mappings) => this.sourceMap(outputPath, node, context, mappings),
      sourceMapping: (generatedPath, sourceRange, context) => this.sourceMapping(generatedPath, sourceRange, context)
    };
  }

  private compileExternDecl(statement: ExternDeclNode, context: RsglCompileContext): void {
    const kind = externResourceKind(statement);
    if (!kind) {
      this.error("rsgl.invalidExternKind", "Extern resource kind must be 'model', 'blockstate', 'item', or 'texture'.", statement.resourceKind?.range ?? statement.range);
      return;
    }
    const idArg = statement.args.find(arg => arg.name?.text === "id")
      ?? statement.args.filter(arg => !arg.name)[0];
    if (!idArg) {
      this.error("rsgl.compileMissingArgument", "Missing extern argument 'id'.", statement.range);
      return;
    }
    const idValue = staticText(idArg.value, context);
    if (!idValue) {
      this.error("rsgl.compileInvalidResourceId", "Extern id must evaluate to a static resource id.", idArg.value.range);
      return;
    }
    if (!parseResourceId(idValue, context.namespace)) {
      this.error("rsgl.compileInvalidResourceId", `Invalid extern resource id '${idValue}'.`, idArg.value.range);
      return;
    }
    this.pushUnit(createExternalResource(
      kind,
      idValue,
      context.namespace,
      context.sourceFile ?? this.options.fileName,
      statement.range,
      context.expansionStack ?? [],
      context.mappingReason ?? "direct"
    ));
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
    const expansion = this.createTemplateExpansion(expression, context);
    if (expansion) {
      if (expansion.definition.node.body.kind !== "Block") {
        this.error(
          "rsgl.invalidTemplateContext",
          `Template '${expansion.definition.name}' expands resource body content and must be used inside a resource declaration.`,
          expression.range
        );
        return;
      }
      this.compileBlock(expansion.definition.node.body, expansion.context);
      return;
    }
    this.error("rsgl.unknownTemplate", "Top-level use must expand a known template.", expression.range);
  }

  private compileResourceBodyFragment(
    useStatement: Extract<ResourceStatementNode, { kind: "UseDecl" }>,
    context: RsglCompileContext,
    kind?: "model" | "item" | JsonResourceFragmentKind
  ): ResourceBodyFragment | undefined {
    const expansion = this.createTemplateExpansion(useStatement.expression, context);
    if (!expansion) {
      return undefined;
    }
    const resourceBody = templateResourceBody(expansion.definition.node.body);
    if (!resourceBody) {
      this.error(
        "rsgl.invalidTemplateContext",
        `Template '${expansion.definition.name}' emits resources and cannot be used inside a resource body.`,
        useStatement.range
      );
      return undefined;
    }
    const body = this.resourceBodyToObjectWithRawMappings(
      resourceBody,
      expansion.context,
      this.resourceBodyFragmentOptions(kind)
    );
    return {
      content: body.content,
      mappings: body.mappings
    };
  }

  private createTemplateExpansion(
    expression: ExprNode,
    context: RsglCompileContext
  ): TemplateExpansion | undefined {
    return createTemplateExpansion(expression, context, this.templateExpansionOptions());
  }

  private compileForStmt(statement: ForStmtNode, context: RsglCompileContext): void {
    const body = statement.body;
    if (body.kind !== "Block") {
      return;
    }
    forEachLoopContext(statement, context, (code, message, range) => this.error(code, message, range), loopContext => {
      this.compileBlock(body, loopContext);
    });
  }

  private compileBlock(body: BlockNode, context: RsglCompileContext): void {
    for (const statement of body.statements) {
      this.compileStatement(statement, context);
    }
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
      rawJsonLoader: this.options.rawJsonLoader,
      globLoader: this.options.globLoader,
      onError: (code, message, range, fileName) => this.error(code, message, range, fileName),
      templates: this.templates
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

  private resourceBodyToObject(
    body: ResourceDeclNode["body"],
    context: RsglCompileContext,
    options: ResourceBodyCompileOptions = {}
  ): Record<string, JsonValue> {
    return resourceBodyToObject(body, context, {
      ...options,
      onError: (code, message, range) => this.error(code, message, range)
    });
  }

  private resourceBodyToObjectWithMappings(
    body: ResourceDeclNode["body"],
    context: RsglCompileContext,
    options: ResourceBodyCompileOptions = {}
  ): { content: Record<string, JsonValue>; mappings: RsglMapping[] } {
    const bodyWithRawMappings = this.resourceBodyToObjectWithRawMappings(body, context, options);
    return {
      content: bodyWithRawMappings.content,
      mappings: bodyWithRawMappings.mappings.map(mapping =>
        this.sourceMapping(mapping.generatedPath, mapping.sourceRange, mapping.context)
      )
    };
  }

  private resourceBodyToObjectWithRawMappings(
    body: ResourceDeclNode["body"],
    context: RsglCompileContext,
    options: ResourceBodyCompileOptions = {}
  ): { content: Record<string, JsonValue>; mappings: ResourceBodyMapping[] } {
    const mappings: ResourceBodyMapping[] = [];
    const content = resourceBodyToObject(body, context, {
      ...options,
      onError: (code, message, range) => this.error(code, message, range),
      onMapping: mapping => {
        mappings.push(mapping);
        options.onMapping?.(mapping);
      }
    });
    return { content, mappings };
  }

  private itemFragmentOptions() {
    return {
      onError: (code: string, message: string, range: { start: number; end: number }) => this.error(code, message, range)
    };
  }

  private resourceBodyFragmentOptions(kind?: "model" | "item" | JsonResourceFragmentKind): ResourceBodyCompileOptions {
    return {
      onUseFragment: (useStatement, fragmentContext) => {
        const templateFragment = this.compileResourceBodyFragment(useStatement, fragmentContext, kind);
        if (templateFragment) {
          return templateFragment;
        }
        if (kind && kind !== "model" && kind !== "item") {
          return compileJsonResourceUseFragment(kind, useStatement, fragmentContext, {
            onError: (code, message, range) => this.error(code, message, range)
          });
        }
        return undefined;
      },
      onSpecialStatement: (statement, fragmentContext) => {
        if (kind === "model") {
          return compileModelGeometryStatement(statement, fragmentContext, {
            onError: (code, message, range) => this.error(code, message, range)
          });
        }
        return kind === "item" && isItemModelStatement(statement)
          ? compileItemSpecialStatement(statement, fragmentContext, this.itemFragmentOptions())
          : undefined;
      }
    };
  }

  private packResourceBodyOptions(): ResourceBodyCompileOptions {
    return {
      ...this.resourceBodyFragmentOptions(),
      onSpecialStatement: (statement, context) => compilePackSpecialStatement(statement, context, this.packOverlayOptions())
    };
  }

  private jsonResourceFragmentOptions(kind: JsonResourceFragmentKind): ResourceBodyCompileOptions {
    const baseOptions = this.resourceBodyFragmentOptions(kind);
    if (kind !== "atlas" && kind !== "equipment") {
      return baseOptions;
    }
    return {
      ...baseOptions,
      onSpecialStatement: (statement, context) =>
        this.compileJsonResourceSpecialStatement(kind, statement, context)
        ?? baseOptions.onSpecialStatement?.(statement, context)
    };
  }

  private compileJsonResourceSpecialStatement(
    kind: JsonResourceFragmentKind,
    statement: ResourceStatementNode,
    context: RsglCompileContext
  ): ResourceBodySpecialResult | undefined {
    if (kind === "atlas") {
      return compileAtlasSpecialStatement(
        statement,
        context,
        (body, bodyContext) => this.resourceBodyToObjectWithRawMappings(body, bodyContext, this.resourceBodyFragmentOptions("atlas")),
        { onError: (code, message, range) => this.error(code, message, range) }
      );
    }
    if (kind === "equipment" && statement.kind === "EquipmentLayerStmt") {
      return compileEquipmentLayerStatement(statement, context, {
        onError: (code, message, range) => this.error(code, message, range)
      });
    }
    return undefined;
  }

  private blockstateCompileOptions(): BlockstateCompileOptions {
    return {
      expandUse: (statement, context) => this.createTemplateExpansion(statement.expression, context),
      onError: (code, message, range) => this.error(code, message, range),
      sourceMap: (outputPath, node, context, mappings) => this.sourceMap(outputPath, node, context, mappings),
      sourceMapping: (generatedPath, sourceRange, context) => this.sourceMapping(generatedPath, sourceRange, context)
    };
  }

  private templateExpansionOptions(): TemplateExpansionOptions {
    return {
      templates: this.templates,
      rawJsonLoader: this.options.rawJsonLoader,
      globLoader: this.options.globLoader,
      createChildContext: (context, values, metadata) => this.createChildContext(context, values, metadata),
      onError: (code, message, range, fileName) => this.error(code, message, range, fileName),
      onDiagnostic: diagnostic => {
        this.diagnostics.push(diagnostic);
      }
    };
  }

  private packOverlayOptions(): PackOverlayCompileOptions {
    return {
      fileName: this.options.fileName,
      targetPackFormat: this.options.targetPackFormat,
      units: this.units,
      overlayEntries: this.overlayEntries,
      onError: (code, message, range) => this.error(code, message, range),
      compileBlock: (body, context) => this.compileBlock(body, context),
      createChildContext: (context, values, metadata) => this.createChildContext(context, values, metadata),
      compilePackBody: (body, context) => this.resourceBodyToObject(body, context, this.packResourceBodyOptions()),
      compilePackBodyWithMappings: (body, context) => this.resourceBodyToObjectWithMappings(body, context, this.packResourceBodyOptions()),
      sourceMap: (outputPath, node, context, mappings) => this.sourceMap(outputPath, node, context, mappings)
    };
  }

  private sourceMap(
    outputPath: string,
    node: { range: { start: number; end: number } },
    context: RsglCompileContext,
    mappings: RsglMapping[] = []
  ) {
    return {
      generatedFile: outputPath,
      mappings: [
        this.sourceMapping("", node.range, context),
        ...mappings
      ]
    };
  }

  private sourceMapping(
    generatedPath: string,
    sourceRange: { start: number; end: number },
    context: Pick<RsglCompileContext, "sourceFile" | "mappingReason" | "expansionStack">
  ): RsglMapping {
    return {
      generatedPath,
      sourceFile: context.sourceFile ?? this.options.fileName,
      sourceRange,
      reason: context.mappingReason ?? "direct",
      expansionStack: context.expansionStack ?? []
    };
  }

  private error(code: string, message: string, range: { start: number; end: number }, fileName?: string): void {
    this.diagnostics.push({ code, message, range, severity: "error", ...(fileName ? { fileName } : {}) });
  }
}

export function createRsglStdlibPreludeTemplates(stdlibRoot?: string): RsglTemplateDefinition[] {
  const files = createRsglStdlibPreludeSourceFiles({ stdlibRoot });
  if (files.length === 0) {
    return [];
  }

  const program = bindRsglProgram(files, { stdlibRoot });
  const environments = createProgramCompileEnvironments(program, undefined);
  return program.models.flatMap(model =>
    Array.from(environments.get(normalizeFileName(model.fileName))?.exportedTemplates.values() ?? [])
  );
}

function externResourceKind(statement: ExternDeclNode): "model" | "blockstate" | "item" | "texture" | null {
  const kind = statement.resourceKind?.text;
  return kind === "model" || kind === "blockstate" || kind === "item" || kind === "texture" ? kind : null;
}

