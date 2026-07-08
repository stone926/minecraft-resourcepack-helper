import { isValidMinecraftNamespace } from "../../../mc-assets/src";
import {
  ArgumentNode,
  BlockNode,
  CallExprNode,
  ExprNode,
  ExternDeclNode,
  ForStmtNode,
  LetDeclNode,
  MultipartBodyNode,
  MultipartSectionStatementNode,
  ResourceBodyNode,
  ResourceDeclNode,
  ResourceStatementNode,
  RsglModule,
  TableDeclNode,
  TextRange,
  TopLevelStatementNode,
  UseDeclNode,
  VariantBodyNode,
  VariantSectionStatementNode
} from "../parser";
import { compileAtlasSpecialStatement } from "./atlasSugar";
import { bindRsglProgram } from "../semantic";
import {
  RsglExternalValueDefinition,
  RsglModuleCompileEnvironment,
  RsglTemplateDefinition,
  createProgramCompileEnvironments,
  createTemplateDefinition
} from "./environment";
import { compileEquipmentLayerStatement, lowerEquipmentBodySugar } from "./equipmentSugar";
import {
  appendBlockstateContent,
  mergeBlockstateContent,
  mergeBlockstateFragment,
  overrideBlockstateContent,
  RsglBlockstateFragment,
  RsglBlockstateFragmentOptions
} from "./blockstateFragments";
import { blockstateVariantKey } from "./blockstateKeys";
import {
  childEvaluationContext,
  EvaluationContext,
  EvaluationValue,
  RawGlobLoader,
  RawJsonLoader,
  evaluateExpression
} from "./evaluate";
import { compileItemSpecialStatement } from "./itemFragments";
import { BinaryCopyRef, JsonValue, ResourceUnit, RsglCompileDiagnostic, RsglCompileResult, RsglMapping } from "./ir";
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
import { parseResourceId, resourceOutputPath } from "./resourceIds";
import { appendGeneratedPath } from "./sourcePaths";
import { RsglTargetPackFormat } from "./target";
import {
  createTemplateExpansion,
  templateResourceBody,
  RsglCompileContext,
  TemplateExpansion,
  TemplateExpansionOptions
} from "./templateExpansion";
import { createExternalResource, normalizeResourceValue } from "./templates";
import { isRsglGenericJsonResourceKind } from "../resourceKinds";
import { createRsglStdlibPreludeSourceFiles } from "../stdlib";
import {
  blockstateMultipartPath,
  blockstateVariantPath,
  compactEquipmentSourceMappings,
  copyResourceTarget,
  copySourcePath,
  currentMultipartLength,
  isExistingFile,
  isItemModelStatement,
  isJsonObject,
  jsonResourceTarget,
  isMultipartEntryPath,
  isPackRelativeTargetExpression,
  isVariantEntryPath,
  normalizeFileName,
  normalizeJsonValue,
  normalizeMcmetaOutputPath,
  offsetMultipartMappings,
  staticText,
  textContent,
  textResourceTarget
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
  externalTemplates?: RsglTemplateDefinition[];
  externalValues?: RsglExternalValueDefinition[];
  environment?: RsglModuleCompileEnvironment;
  rawJsonLoader?: RawJsonLoader;
  globLoader?: RawGlobLoader;
  targetPackFormat?: RsglTargetPackFormat;
  stdlibRoot?: string;
}

type BlockstateBodyCompileResult = {
  content: Record<string, JsonValue>;
  mappings: RsglMapping[];
};

type VariantEntriesCompileResult = {
  entries: Record<string, JsonValue>;
  mappings: RsglMapping[];
};

type MultipartEntriesCompileResult = {
  entries: JsonValue[];
  mappings: RsglMapping[];
};

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
    for (const template of rsglStdlibPreludeTemplates(this.options.stdlibRoot)) {
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
    if (statement.resourceKind === "model") {
      this.pushUnit(this.compileModel(statement, context));
    } else if (statement.resourceKind === "item") {
      this.pushUnit(this.compileItem(statement, context));
    } else if (statement.resourceKind === "blockstate") {
      this.pushUnit(this.compileBlockstate(statement, context));
    } else if (isRsglGenericJsonResourceKind(statement.resourceKind)) {
      this.pushUnit(this.compileGenericJsonResource(statement, context));
    } else if (statement.resourceKind === "json") {
      this.pushUnit(this.compileArbitraryJsonResource(statement, context));
    } else if (statement.resourceKind === "pack") {
      this.pushUnit(compilePackResource(statement, context, this.packOverlayOptions()));
    } else if (statement.resourceKind === "lang") {
      this.pushUnit(this.compileLang(statement, context));
    } else if (statement.resourceKind === "sounds") {
      this.pushUnit(this.compileSounds(statement, context));
    } else if (statement.resourceKind === "text") {
      this.pushUnit(this.compileTextResource(statement, context));
    } else if (statement.resourceKind === "copy") {
      this.pushUnit(this.compileCopyResource(statement, context));
    } else if (statement.resourceKind === "mcmeta") {
      for (const unit of this.compileMcmeta(statement, context)) {
        this.pushUnit(unit);
      }
    }
  }

  private compileModel(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const idValue = statement.id ? staticText(statement.id, context) : null;
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
    const body = this.resourceBodyToObjectWithMappings(statement.body, context, this.resourceBodyFragmentOptions("model"));
    const content = statement.impl
      ? this.applyModelImpl(statement, subtype, body.content, context)
      : body.content;
    return {
      id: modelId,
      kind: "model",
      outputPath,
      content,
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(outputPath, statement, context, body.mappings)
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

  private applyModelImpl(
    statement: ResourceDeclNode,
    subtype: string,
    body: Record<string, JsonValue>,
    context: RsglCompileContext
  ): Record<string, JsonValue> {
    if (!statement.impl) {
      return body;
    }
    const impl = modelImplContent(statement.impl, subtype, context, (code, message, range) => this.error(code, message, range));
    if (!impl) {
      return body;
    }
    if (Object.hasOwn(body, "parent")) {
      this.error("rsgl.duplicateModelParent", "Model body must not declare 'parent' when using impl.", statement.impl.range);
    }
    const { textures: bodyTextures, ...rest } = body;
    delete rest.parent;
    const mergedTextures = {
      ...impl.textures,
      ...(isJsonObject(bodyTextures) ? bodyTextures : {})
    };
    return {
      parent: impl.parent,
      ...(Object.keys(mergedTextures).length > 0 ? { textures: mergedTextures } : {}),
      ...rest
    };
  }

  private compileItem(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const idValue = statement.id ? staticText(statement.id, context) : null;
    const id = idValue ? parseResourceId(idValue, context.namespace) : null;
    if (!id || !statement.id) {
      this.error("rsgl.compileMissingResourceId", "Item declaration requires a static id.", statement.range);
      return null;
    }
    const body = this.resourceBodyToObjectWithMappings(statement.body, context, this.resourceBodyFragmentOptions("item"));
    const model = typeof body.content.model === "string"
      ? { type: "minecraft:model", model: body.content.model }
      : body.content.model;
    const outputPath = resourceOutputPath("item", id);
    return {
      id,
      kind: "item",
      outputPath,
      content: { ...body.content, model: normalizeJsonValue(model) },
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(outputPath, statement, context, body.mappings)
    };
  }

  private compileBlockstate(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const idValue = statement.id ? staticText(statement.id, context) : null;
    const id = idValue ? parseResourceId(idValue, context.namespace) : null;
    if (!id || !statement.id) {
      this.error("rsgl.compileMissingResourceId", "Blockstate declaration requires a static id.", statement.range);
      return null;
    }
    const body = this.compileBlockstateBody(statement.body, context);
    const outputPath = resourceOutputPath("blockstate", id);
    return {
      id,
      kind: "blockstate",
      outputPath,
      content: body.content,
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(outputPath, statement, context, body.mappings)
    };
  }

  private compileBlockstateBody(body: ResourceBodyNode, context: RsglCompileContext): BlockstateBodyCompileResult {
    const result: BlockstateBodyCompileResult = { content: {}, mappings: [] };
    for (const statement of body.statements) {
      this.compileBlockstateBodyStatement(statement, context, result);
    }
    return result;
  }

  private compileBlockstateBodyStatement(
    statement: ResourceStatementNode,
    context: RsglCompileContext,
    result: BlockstateBodyCompileResult
  ): void {
    const fragmentOptions = this.blockstateFragmentOptions();
    if (statement.kind === "VariantsSection") {
      const variants = this.compileVariantEntries(statement.entries, context);
      mergeBlockstateFragment(result.content, { variants: variants.entries }, statement.range, fragmentOptions);
      result.mappings.push(this.sourceMapping("/variants", statement.range, context), ...variants.mappings);
    } else if (statement.kind === "MultipartSection") {
      const multipart = this.compileMultipartEntries(statement.entries, context, currentMultipartLength(result.content));
      mergeBlockstateFragment(result.content, { multipart: multipart.entries }, statement.range, fragmentOptions);
      result.mappings.push(this.sourceMapping("/multipart", statement.range, context), ...multipart.mappings);
    } else if (statement.kind === "UseDecl") {
      const fragment = this.compileBlockstateUse(statement, context);
      const multipartOffset = currentMultipartLength(result.content);
      mergeBlockstateFragment(result.content, fragment, statement.range, fragmentOptions);
      result.mappings.push(...this.blockstateFragmentMappings(fragment, statement.range, context, multipartOffset));
    } else if (statement.kind === "LetDecl") {
      this.compileLetDecl(statement, context);
    } else if (statement.kind === "ForStmt") {
      const body = statement.body;
      if (body.kind !== "ResourceBody") {
        return;
      }
      forEachLoopContext(statement, context, (code, message, range) => this.error(code, message, range), loopContext => {
        const loopContent = this.compileBlockstateBody(body, loopContext);
        const multipartOffset = currentMultipartLength(result.content);
        mergeBlockstateContent(result.content, loopContent.content, statement.range, fragmentOptions);
        result.mappings.push(...offsetMultipartMappings(loopContent.mappings, multipartOffset));
      });
    } else if (statement.kind === "IfStmt") {
      const body = evaluateExpression(statement.condition, context) ? statement.thenBody : statement.elseBody;
      if (body?.kind === "ResourceBody") {
        const branchContent = this.compileBlockstateBody(body, context);
        const multipartOffset = currentMultipartLength(result.content);
        mergeBlockstateContent(result.content, branchContent.content, statement.range, fragmentOptions);
        result.mappings.push(...offsetMultipartMappings(branchContent.mappings, multipartOffset));
      }
    } else if (statement.kind === "RawJsonStmt") {
      const value = normalizeJsonValue(evaluateExpression(statement.value, context));
      if (isJsonObject(value)) {
        const multipartOffset = currentMultipartLength(result.content);
        mergeBlockstateContent(result.content, value, statement.range, fragmentOptions);
        result.mappings.push(...this.blockstateObjectMappings(value, statement.range, context, multipartOffset));
      } else {
        this.error("rsgl.invalidRawJsonFragment", "raw_json must evaluate to an object fragment.", statement.value.range);
      }
    } else if (statement.kind === "OverrideStmt") {
      const value = normalizeJsonValue(evaluateExpression(statement.value, context));
      if (isJsonObject(value)) {
        const applied = overrideBlockstateContent(result.content, value, statement.create, statement.range, fragmentOptions);
        result.mappings.push(...this.blockstateObjectMappings(applied, statement.range, context, 0));
      } else {
        this.error("rsgl.invalidOverrideFragment", "override must evaluate to an object fragment.", statement.value.range);
      }
    } else if (statement.kind === "AppendStmt") {
      const value = normalizeJsonValue(evaluateExpression(statement.value, context));
      if (isJsonObject(value)) {
        const appended = appendBlockstateContent(result.content, value, statement.range, fragmentOptions);
        result.mappings.push(...this.blockstateObjectMappings(appended.applied, statement.range, context, appended.multipartOffset));
      } else {
        this.error("rsgl.invalidAppendFragment", "append must evaluate to an object fragment.", statement.value.range);
      }
    }
  }

  private compileVariantEntries(
    statements: VariantSectionStatementNode[],
    context: RsglCompileContext
  ): VariantEntriesCompileResult {
    const result: VariantEntriesCompileResult = { entries: {}, mappings: [] };
    for (const statement of statements) {
      this.compileVariantStatement(statement, context, result);
    }
    return result;
  }

  private compileVariantBody(
    body: VariantBodyNode,
    context: RsglCompileContext,
    result: VariantEntriesCompileResult
  ): void {
    for (const statement of body.statements) {
      this.compileVariantStatement(statement, context, result);
    }
  }

  private compileVariantStatement(
    statement: VariantSectionStatementNode,
    context: RsglCompileContext,
    result: VariantEntriesCompileResult
  ): void {
    if (statement.kind === "VariantEntry") {
      const state = blockstateVariantKey(normalizeJsonValue(evaluateExpression(statement.state, context)));
      result.entries[state] = normalizeJsonValue(evaluateExpression(statement.value, context));
      result.mappings.push(this.sourceMapping(blockstateVariantPath(state), statement.range, context));
    } else if (statement.kind === "LetDecl") {
      this.compileLetDecl(statement, context);
    } else if (statement.kind === "UseDecl") {
      const fragment = this.compileBlockstateUse(statement, context);
      if (fragment.multipart) {
        this.error("rsgl.incompatibleBlockstateFragment", "Multipart template fragments cannot be used inside a variants section.", statement.range);
      }
      if (fragment.variants) {
        Object.assign(result.entries, fragment.variants);
        result.mappings.push(...this.blockstateFragmentVariantMappings(fragment, statement.range, context));
      }
    } else if (statement.kind === "ForStmt") {
      const body = statement.body;
      if (body.kind !== "VariantBody") {
        return;
      }
      forEachLoopContext(statement, context, (code, message, range) => this.error(code, message, range), loopContext => {
        this.compileVariantBody(body, loopContext, result);
      });
    } else if (statement.kind === "IfStmt") {
      const body = evaluateExpression(statement.condition, context) ? statement.thenBody : statement.elseBody;
      if (body?.kind === "VariantBody") {
        this.compileVariantBody(body, context, result);
      }
    }
  }

  private compileMultipartEntries(
    statements: MultipartSectionStatementNode[],
    context: RsglCompileContext,
    startIndex = 0
  ): MultipartEntriesCompileResult {
    const result: MultipartEntriesCompileResult = { entries: [], mappings: [] };
    for (const statement of statements) {
      this.compileMultipartStatement(statement, context, result, startIndex);
    }
    return result;
  }

  private compileMultipartBody(
    body: MultipartBodyNode,
    context: RsglCompileContext,
    result: MultipartEntriesCompileResult,
    startIndex: number
  ): void {
    for (const statement of body.statements) {
      this.compileMultipartStatement(statement, context, result, startIndex);
    }
  }

  private compileMultipartStatement(
    statement: MultipartSectionStatementNode,
    context: RsglCompileContext,
    result: MultipartEntriesCompileResult,
    startIndex: number
  ): void {
    if (statement.kind === "MultipartEntry") {
      const value: Record<string, JsonValue> = {
        apply: normalizeJsonValue(evaluateExpression(statement.apply, context))
      };
      if (statement.when) {
        value.when = normalizeJsonValue(evaluateExpression(statement.when, context));
      }
      const index = startIndex + result.entries.length;
      result.entries.push(value);
      result.mappings.push(this.sourceMapping(blockstateMultipartPath(index), statement.range, context));
    } else if (statement.kind === "LetDecl") {
      this.compileLetDecl(statement, context);
    } else if (statement.kind === "UseDecl") {
      const fragment = this.compileBlockstateUse(statement, context);
      if (fragment.variants) {
        this.error("rsgl.incompatibleBlockstateFragment", "Variant template fragments cannot be used inside a multipart section.", statement.range);
      }
      if (fragment.multipart) {
        const offset = startIndex + result.entries.length;
        result.entries.push(...fragment.multipart);
        result.mappings.push(...this.blockstateFragmentMultipartMappings(fragment, statement.range, context, offset));
      }
    } else if (statement.kind === "ForStmt") {
      const body = statement.body;
      if (body.kind !== "MultipartBody") {
        return;
      }
      forEachLoopContext(statement, context, (code, message, range) => this.error(code, message, range), loopContext => {
        this.compileMultipartBody(body, loopContext, result, startIndex);
      });
    } else if (statement.kind === "IfStmt") {
      const body = evaluateExpression(statement.condition, context) ? statement.thenBody : statement.elseBody;
      if (body?.kind === "MultipartBody") {
        this.compileMultipartBody(body, context, result, startIndex);
      }
    }
  }

  private compileGenericJsonResource(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const resourceKind = statement.resourceKind;
    if (!isRsglGenericJsonResourceKind(resourceKind)) {
      this.error("rsgl.invalidGenericJsonResource", `${resourceKind} is not a generic JSON resource kind.`, statement.range);
      return null;
    }
    const idValue = statement.id ? staticText(statement.id, context) : null;
    const id = idValue ? parseResourceId(idValue, context.namespace) : null;
    if (!id || !statement.id) {
      this.error("rsgl.compileMissingResourceId", `${resourceKind} declaration requires a static id.`, statement.range);
      return null;
    }
    const outputPath = resourceOutputPath(resourceKind, id);
    const body = this.resourceBodyToObjectWithMappings(statement.body, context, this.jsonResourceFragmentOptions(resourceKind));
    let content = body.content;
    let mappings = body.mappings;
    if (resourceKind === "equipment") {
      const equipmentBody = lowerEquipmentBodySugar(content, context, statement.range, {
        onError: (code, message, range) => this.error(code, message, range)
      });
      content = equipmentBody.content;
      mappings = equipmentBody.compactLayers ? compactEquipmentSourceMappings(mappings) : mappings;
    }
    return {
      id,
      kind: resourceKind,
      outputPath,
      content,
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(outputPath, statement, context, mappings)
    };
  }

  private compileArbitraryJsonResource(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const targetValue = statement.id ? staticText(statement.id, context) : null;
    if (!targetValue || !statement.id) {
      this.error("rsgl.compileMissingResourceId", "JSON declaration requires a static resource id or pack-relative path.", statement.range);
      return null;
    }
    const target = jsonResourceTarget(targetValue, context.namespace, isPackRelativeTargetExpression(statement.id));
    if (!target) {
      this.error("rsgl.compileInvalidJsonTarget", `Invalid JSON resource target '${targetValue}'.`, statement.id.range);
      return null;
    }

    const body = this.resourceBodyToObjectWithMappings(statement.body, context, this.resourceBodyFragmentOptions());
    return {
      id: target.id,
      kind: "json",
      outputPath: target.outputPath,
      content: body.content,
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(target.outputPath, statement, context, body.mappings)
    };
  }

  private compileLang(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const idValue = statement.id ? staticText(statement.id, context) : null;
    const id = idValue ? parseResourceId(idValue, context.namespace) : null;
    if (!id || !statement.id) {
      this.error("rsgl.compileMissingResourceId", "Lang declaration requires a static locale id.", statement.range);
      return null;
    }
    const outputPath = resourceOutputPath("lang", id);
    const body = this.resourceBodyToObjectWithMappings(statement.body, context, this.resourceBodyFragmentOptions());
    return {
      id,
      kind: "lang",
      outputPath,
      content: body.content,
      mergePolicy: { kind: "mergeObject" },
      sourceMap: this.sourceMap(outputPath, statement, context, body.mappings)
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
    const body = this.resourceBodyToObjectWithMappings(statement.body, context, this.resourceBodyFragmentOptions());
    return {
      id,
      kind: "sounds",
      outputPath,
      content: body.content,
      mergePolicy: { kind: "mergeObject" },
      sourceMap: this.sourceMap(outputPath, statement, context, body.mappings)
    };
  }

  private compileTextResource(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const targetValue = statement.id ? staticText(statement.id, context) : null;
    if (!targetValue || !statement.id) {
      this.error("rsgl.compileMissingResourceId", "Text declaration requires a static resource id or pack-relative path.", statement.range);
      return null;
    }
    const target = textResourceTarget(targetValue, context.namespace);
    if (!target) {
      this.error("rsgl.compileInvalidTextTarget", `Invalid text resource target '${targetValue}'.`, statement.id.range);
      return null;
    }

    const body = this.resourceBodyToObjectWithRawMappings(statement.body, context, this.resourceBodyFragmentOptions());
    for (const key of Object.keys(body.content)) {
      if (key !== "content") {
        this.error("rsgl.invalidTextResourceField", `Text resources do not support field '${key}'.`, statement.body.range);
      }
    }
    const text = textContent(body.content.content);
    if (text === null) {
      this.error("rsgl.invalidTextContent", "Text resource requires a scalar 'content' field.", statement.body.range);
      return null;
    }

    const mappings = body.mappings
      .filter(mapping => mapping.generatedPath === "/content")
      .map(mapping => this.sourceMapping("", mapping.sourceRange, mapping.context));
    return {
      id: target.id,
      kind: "text",
      outputPath: target.outputPath,
      content: { kind: "text", text },
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(target.outputPath, statement, context, mappings)
    };
  }

  private compileCopyResource(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const targetValue = statement.id ? staticText(statement.id, context) : null;
    if (!targetValue || !statement.id) {
      this.error("rsgl.compileMissingResourceId", "Copy declaration requires a static resource id or pack-relative path.", statement.range);
      return null;
    }
    const target = copyResourceTarget(targetValue, context.namespace, isPackRelativeTargetExpression(statement.id));
    if (!target) {
      this.error("rsgl.compileInvalidCopyTarget", `Invalid copy resource target '${targetValue}'.`, statement.id.range);
      return null;
    }

    const body = this.resourceBodyToObjectWithRawMappings(statement.body, context, this.resourceBodyFragmentOptions());
    for (const key of Object.keys(body.content)) {
      if (key !== "from") {
        this.error("rsgl.invalidCopyResourceField", `Copy resources do not support field '${key}'.`, statement.body.range);
      }
    }
    const sourcePath = copySourcePath(body.content.from, context.sourceFile ?? this.options.fileName);
    if (!sourcePath) {
      this.error("rsgl.invalidCopySource", "Copy resource requires a static string 'from' field.", statement.body.range);
      return null;
    }
    if (!isExistingFile(sourcePath)) {
      this.error("rsgl.copySourceNotFound", `Copy source file not found: ${sourcePath}`, statement.body.range);
      return null;
    }

    const mappings = body.mappings
      .filter(mapping => mapping.generatedPath === "/from")
      .map(mapping => this.sourceMapping("", mapping.sourceRange, mapping.context));
    const content: BinaryCopyRef = { kind: "copy", sourcePath };
    return {
      id: target.id,
      kind: "copy",
      outputPath: target.outputPath,
      content,
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(target.outputPath, statement, context, mappings)
    };
  }

  private compileMcmeta(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit[] {
    const targetValues = this.mcmetaTargetValues(statement, context);
    if (!targetValues) {
      return [];
    }
    const body = this.resourceBodyToObjectWithMappings(statement.body, context, this.jsonResourceFragmentOptions("mcmeta"));
    const units: ResourceUnit[] = [];
    for (const idValue of targetValues) {
      const target = this.mcmetaTarget(idValue, context.namespace);
      if (!target) {
        this.error("rsgl.compileInvalidResourceId", `Invalid mcmeta target '${idValue}'.`, statement.id?.range ?? statement.range);
        continue;
      }
      units.push({
        id: target.id,
        kind: "mcmeta",
        outputPath: target.outputPath,
        content: body.content,
        mergePolicy: { kind: "errorOnConflict" },
        sourceMap: this.sourceMap(target.outputPath, statement, context, body.mappings)
      });
    }
    return units;
  }

  private mcmetaTargetValues(statement: ResourceDeclNode, context: RsglCompileContext): string[] | null {
    if (!statement.id) {
      this.error("rsgl.compileMissingResourceId", "Mcmeta declaration requires a static target path.", statement.range);
      return null;
    }
    const value = evaluateExpression(statement.id, context);
    if (Array.isArray(value)) {
      const targets: string[] = [];
      for (const item of value) {
        if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
          targets.push(String(item));
        } else {
          this.error("rsgl.compileInvalidResourceId", "Mcmeta glob results must be static path strings.", statement.id.range);
        }
      }
      if (targets.length === 0) {
        this.error("rsgl.mcmetaGlobNoMatches", "mcmeta glob did not match any target PNG files.", statement.id.range);
      }
      return targets;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return [String(value)];
    }
    this.error("rsgl.compileMissingResourceId", "Mcmeta declaration requires a static target path.", statement.range);
    return null;
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

  private compileBlockstateUse(
    useStatement: UseDeclNode,
    context: RsglCompileContext
  ): RsglBlockstateFragment {
    return this.compileBlockstateUserFragment(useStatement, context) ?? {};
  }

  private compileBlockstateUserFragment(
    useStatement: UseDeclNode,
    context: RsglCompileContext
  ): RsglBlockstateFragment | undefined {
    const expansion = this.createTemplateExpansion(useStatement.expression, context);
    if (!expansion) {
      return undefined;
    }
    const resourceBody = templateResourceBody(expansion.definition.node.body);
    if (!resourceBody) {
      this.error(
        "rsgl.invalidTemplateContext",
        `Template '${expansion.definition.name}' emits resources and cannot be used inside a blockstate body.`,
        useStatement.range
      );
      return undefined;
    }
    const body = this.compileBlockstateBody(resourceBody, expansion.context);
    const content = body.content;
    const fragment: RsglBlockstateFragment = {};
    if (isJsonObject(content.variants)) {
      fragment.variants = content.variants;
    }
    if (Array.isArray(content.multipart)) {
      fragment.multipart = content.multipart;
    }
    fragment.mappings = body.mappings;
    return fragment;
  }

  private blockstateFragmentMappings(
    fragment: RsglBlockstateFragment,
    sourceRange: { start: number; end: number },
    context: RsglCompileContext,
    multipartOffset: number
  ): RsglMapping[] {
    if (fragment.mappings?.length) {
      return offsetMultipartMappings(fragment.mappings, multipartOffset);
    }
    return [
      ...this.blockstateFragmentVariantMappings(fragment, sourceRange, context, true),
      ...this.blockstateFragmentMultipartMappings(fragment, sourceRange, context, multipartOffset, true)
    ];
  }

  private blockstateFragmentVariantMappings(
    fragment: RsglBlockstateFragment,
    sourceRange: { start: number; end: number },
    context: RsglCompileContext,
    includeSection = false
  ): RsglMapping[] {
    if (fragment.mappings?.length) {
      return fragment.mappings.filter(mapping => isVariantEntryPath(mapping.generatedPath));
    }
    if (!fragment.variants) {
      return [];
    }
    const mappings = includeSection ? [this.sourceMapping("/variants", sourceRange, context)] : [];
    for (const key of Object.keys(fragment.variants)) {
      mappings.push(this.sourceMapping(blockstateVariantPath(key), sourceRange, context));
    }
    return mappings;
  }

  private blockstateFragmentMultipartMappings(
    fragment: RsglBlockstateFragment,
    sourceRange: { start: number; end: number },
    context: RsglCompileContext,
    offset: number,
    includeSection = false
  ): RsglMapping[] {
    if (fragment.mappings?.length) {
      return offsetMultipartMappings(fragment.mappings.filter(mapping => isMultipartEntryPath(mapping.generatedPath)), offset);
    }
    if (!fragment.multipart) {
      return [];
    }
    const mappings = includeSection ? [this.sourceMapping("/multipart", sourceRange, context)] : [];
    fragment.multipart.forEach((_, index) => {
      mappings.push(this.sourceMapping(blockstateMultipartPath(offset + index), sourceRange, context));
    });
    return mappings;
  }

  private blockstateObjectMappings(
    value: Record<string, JsonValue>,
    sourceRange: { start: number; end: number },
    context: RsglCompileContext,
    multipartOffset: number
  ): RsglMapping[] {
    const mappings: RsglMapping[] = [];
    for (const [key, entryValue] of Object.entries(value)) {
      if (key === "variants" && isJsonObject(entryValue)) {
        mappings.push(this.sourceMapping("/variants", sourceRange, context));
        for (const variantKey of Object.keys(entryValue)) {
          mappings.push(this.sourceMapping(blockstateVariantPath(variantKey), sourceRange, context));
        }
      } else if (key === "multipart" && Array.isArray(entryValue)) {
        mappings.push(this.sourceMapping("/multipart", sourceRange, context));
        entryValue.forEach((_, index) => {
          mappings.push(this.sourceMapping(blockstateMultipartPath(multipartOffset + index), sourceRange, context));
        });
      } else {
        mappings.push(this.sourceMapping(appendGeneratedPath("", key), sourceRange, context));
      }
    }
    return mappings;
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

  private soundsNamespace(statement: ResourceDeclNode, context: RsglCompileContext): string | null {
    const idValue = statement.id ? staticText(statement.id, context) : null;
    if (!idValue) {
      return null;
    }
    if (isValidMinecraftNamespace(idValue)) {
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
      rawJsonLoader: this.options.rawJsonLoader,
      globLoader: this.options.globLoader,
      onError: (code, message, range) => this.error(code, message, range),
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

  private blockstateFragmentOptions(): RsglBlockstateFragmentOptions {
    return {
      onError: (code, message, range) => this.error(code, message, range)
    };
  }

  private templateExpansionOptions(): TemplateExpansionOptions {
    return {
      templates: this.templates,
      rawJsonLoader: this.options.rawJsonLoader,
      globLoader: this.options.globLoader,
      createChildContext: (context, values, metadata) => this.createChildContext(context, values, metadata),
      onError: (code, message, range) => this.error(code, message, range),
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

  private error(code: string, message: string, range: { start: number; end: number }): void {
    this.diagnostics.push({ code, message, range, severity: "error" });
  }
}

function rsglStdlibPreludeTemplates(stdlibRoot?: string): RsglTemplateDefinition[] {
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

function modelImplContent(
  expression: ExprNode,
  subtype: string,
  context: RsglCompileContext,
  onError: (code: string, message: string, range: TextRange) => void
): { parent: string; textures: Record<string, JsonValue> } | null {
  const call = expression.kind === "CallExpr" ? expression : undefined;
  const parentExpression = call?.callee ?? expression;
  const parentValue = scalarText(evaluateExpression(parentExpression, context));
  if (!parentValue) {
    onError("rsgl.invalidModelImplParent", "Model impl parent must evaluate to a static model id.", parentExpression.range);
    return null;
  }
  const textures = modelImplTextures(call, subtype, context, onError);
  return {
    parent: normalizeModelParent(parentValue, subtype, context.namespace),
    textures
  };
}

function modelImplTextures(
  call: CallExprNode | undefined,
  subtype: string,
  context: RsglCompileContext,
  onError: (code: string, message: string, range: TextRange) => void
): Record<string, JsonValue> {
  if (!call) {
    return {};
  }
  const textures: Record<string, JsonValue> = {};
  const positional = call.args.filter(arg => !arg.name);
  if (positional.length > 1) {
    onError("rsgl.invalidModelImplArgument", "Model impl allows named texture arguments, or one positional texture argument.", call.range);
  }
  if (positional.length === 1) {
    const value = modelImplTextureValue(positional[0], subtype, context, onError);
    if (value) {
      textures[subtype === "item" ? "layer0" : "all"] = value;
    }
  }
  for (const arg of call.args.filter(arg => arg.name)) {
    const value = modelImplTextureValue(arg, subtype, context, onError);
    if (value && arg.name) {
      textures[arg.name.text] = value;
    }
  }
  return textures;
}

function modelImplTextureValue(
  arg: ArgumentNode,
  subtype: string,
  context: RsglCompileContext,
  onError: (code: string, message: string, range: TextRange) => void
): string | null {
  const value = scalarText(evaluateExpression(arg.value, context));
  if (!value) {
    onError("rsgl.invalidModelImplArgument", "Model impl texture argument must evaluate to a static texture id.", arg.value.range);
    return null;
  }
  return normalizeResourceValue(value, context.namespace, subtype === "item" ? "item" : "block");
}

function normalizeModelParent(value: string, subtype: string, namespace: string): string {
  if (value.includes(":")) {
    return value;
  }
  if (value.includes("/")) {
    return `${namespace}:${value}`;
  }
  return `minecraft:${subtype}/${value}`;
}

function scalarText(value: EvaluationValue): string | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}
