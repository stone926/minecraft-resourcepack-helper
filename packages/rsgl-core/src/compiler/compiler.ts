import * as path from "node:path";
import {
  BlockNode,
  ExprNode,
  ForStmtNode,
  LetDeclNode,
  MultipartBodyNode,
  MultipartSectionStatementNode,
  OverlayDeclNode,
  PackFilterBlockStmtNode,
  PackFormatsStmtNode,
  PackOverlayStmtNode,
  ParameterNode,
  ResourceBodyNode,
  ResourceDeclNode,
  ResourceStatementNode,
  RsglModule,
  SugarDeclNode,
  TableDeclNode,
  TopLevelStatementNode,
  UseDeclNode,
  VariantBodyNode,
  VariantSectionStatementNode
} from "../parser";
import { bindRsglArguments, RsglCallableParameter } from "../arguments";
import { compileAtlasSpecialStatement } from "./atlasSugar";
import {
  bindRsglModule,
  bindRsglProgram,
  RsglProgram,
  RsglSourceFile
} from "../semantic";
import {
  RsglExternalValueDefinition,
  RsglFragmentDefinition,
  RsglModuleCompileEnvironment,
  RsglTemplateDefinition,
  createFragmentDefinition,
  createProgramCompileEnvironments,
  createStandaloneCompileEnvironment,
  createTemplateDefinition,
  mapToExternalValues
} from "./environment";
import { compileEquipmentLayerStatement, lowerEquipmentBodySugar } from "./equipmentSugar";
import {
  compileBlockstateUseFragment,
  compileBlockstateValueFragment,
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
import { compileFamilySugar } from "./familySugar";
import { compileBuiltinUse } from "./builtinUse";
import { compileItemSpecialStatement, compileItemUseFragment } from "./itemFragments";
import { BinaryCopyRef, JsonValue, ResourceUnit, RsglCompileDiagnostic, RsglCompileResult, RsglMapping } from "./ir";
import { lowerItemUnitsForTarget } from "./itemLegacyBackend";
import { compileJsonResourceUseFragment, JsonResourceFragmentKind } from "./jsonResourceFragments";
import { createLoopBindings, createLoopContext as createEvaluationLoopContext } from "./looping";
import { mergeResourceUnits } from "./merge";
import { ResourceBodyCompileOptions, ResourceBodyFragment, ResourceBodyMapping, ResourceBodySpecialResult, resourceBodyToObject } from "./resourceBody";
import { parseResourceId, resourceOutputPath } from "./resourceIds";
import { appendGeneratedPath } from "./sourcePaths";
import { resolveTargetPackFormat, RsglTargetPackFormat } from "./target";
import {
  createCubeAllModel,
  createFenceBlockstate,
  createItemMapping,
  createPaneBlockstate,
  createSlabBlockstate,
  createStairsBlockstate,
  createWallBlockstate
} from "./templates";
import { RsglResourceValidationOptions, validateResourceUnits } from "./validation";
import { RsglWorkspaceSourceCache } from "../workspaceSource";
import { isRsglGenericJsonResourceKind } from "../resourceKinds";
import {
  blockstateMultipartPath,
  blockstateVariantPath,
  compactEquipmentSourceMappings,
  copyResourceTarget,
  copySourcePath,
  createCompileGlobLoader,
  createCompileRawJsonLoader,
  createResourceBodyFragment,
  currentMultipartLength,
  detectOutputConflicts,
  hasErrors,
  isExistingFile,
  isItemModelStatement,
  isJsonObject,
  isMultipartEntryPath,
  isPackRelativeTargetExpression,
  isVariantEntryPath,
  moduleSyntaxDiagnostics,
  normalizeFileName,
  normalizeJsonValue,
  normalizeMcmetaOutputPath,
  offsetMultipartMappings,
  packContentFromBody,
  packFormatMetadata,
  packSourceMappings,
  prefixOverlayUnit,
  selectProgramModels,
  semanticProgramMatchesFiles,
  textContent,
  textResourceTarget,
  withTargetPackFormat
} from "./compilerHelpers";

const namespacePattern = /^[a-z0-9_.-]+$/;

export interface RsglCompileOptions extends RsglResourceValidationOptions {
  fileName?: string;
  namespace?: string;
}

export interface RsglProgramCompileOptions extends RsglResourceValidationOptions {
  entryFileName?: string;
  namespace?: string;
  semanticProgram?: RsglProgram;
}

export interface RsglFileLoadOptions {
  encoding?: BufferEncoding;
}

export interface RsglFileCompileOptions extends Omit<RsglProgramCompileOptions, "entryFileName">, RsglFileLoadOptions { }

export interface RsglDirectoryCompileOptions extends Omit<RsglProgramCompileOptions, "entryFileName">, RsglFileLoadOptions { }

interface RsglCompilerOptions {
  fileName: string;
  namespace: string;
  externalTemplates?: RsglTemplateDefinition[];
  externalFragments?: RsglFragmentDefinition[];
  externalValues?: RsglExternalValueDefinition[];
  environment?: RsglModuleCompileEnvironment;
  rawJsonLoader?: RawJsonLoader;
  globLoader?: RawGlobLoader;
  targetPackFormat?: RsglTargetPackFormat;
}

type RsglCompileContext = EvaluationContext & {
  templates?: Map<string, RsglTemplateDefinition>;
  fragments?: Map<string, RsglFragmentDefinition>;
};

type TemplateCallParameter = RsglCallableParameter & {
  parameterNode: ParameterNode;
};

type FragmentExpansion = {
  definition: RsglFragmentDefinition;
  context: RsglCompileContext;
};

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

export function compileRsglModule(module: RsglModule, options: RsglCompileOptions = {}): RsglCompileResult {
  const syntaxDiagnostics = moduleSyntaxDiagnostics(module, options.fileName);
  if (hasErrors(syntaxDiagnostics)) {
    return { units: [], diagnostics: syntaxDiagnostics };
  }

  const semanticModel = bindRsglModule(module, { fileName: options.fileName });
  const namespace = options.namespace ?? semanticModel.namespace ?? "minecraft";
  const rawJsonDiagnostics: RsglCompileDiagnostic[] = [];
  const rawJsonLoader = createCompileRawJsonLoader(options.fileName ?? "<anonymous>", rawJsonDiagnostics);
  const globLoader = createCompileGlobLoader(options.fileName ?? "<anonymous>", rawJsonDiagnostics);
  const target = resolveTargetPackFormat([{ module, namespace }]);
  const environment = createStandaloneCompileEnvironment(
    semanticModel,
    namespace,
    { rawJsonLoader, globLoader }
  );
  const compiler = new RsglCompiler(module, {
    fileName: options.fileName ?? "<anonymous>",
    namespace,
    environment,
    rawJsonLoader,
    globLoader,
    targetPackFormat: target.targetPackFormat
  });
  const result = compiler.compile();
  const lowered = lowerItemUnitsForTarget(result.units, target.targetPackFormat);
  const merged = mergeResourceUnits(lowered.units);
  const validationOptions = withTargetPackFormat(options, target.targetPackFormat);
  return {
    units: merged.units,
    diagnostics: [
      ...semanticModel.diagnostics.map(diagnostic => ({ ...diagnostic })),
      ...target.diagnostics,
      ...rawJsonDiagnostics,
      ...result.diagnostics,
      ...lowered.diagnostics,
      ...merged.diagnostics,
      ...detectOutputConflicts(merged.units),
      ...validateResourceUnits(merged.units, validationOptions)
    ]
  };
}

export function compileRsglFile(entryFileName: string, options: RsglFileCompileOptions = {}): RsglCompileResult {
  const { encoding, ...compileOptions } = options;
  const resolvedEntryFileName = path.resolve(entryFileName);
  const files = loadRsglSourceFilesFromFile(resolvedEntryFileName, { encoding });
  return compileRsglProgram(files, { ...compileOptions, entryFileName: resolvedEntryFileName });
}

export function compileRsglDirectory(rootDirectory: string, options: RsglDirectoryCompileOptions = {}): RsglCompileResult {
  const { encoding, ...compileOptions } = options;
  const resolvedRootDirectory = path.resolve(rootDirectory);
  const files = loadRsglSourceFilesFromDirectory(resolvedRootDirectory, { encoding });
  if (files.length === 0) {
    return {
      units: [],
      diagnostics: [{
        code: "rsgl.compileMissingSource",
        message: `No RSGL source files found in ${resolvedRootDirectory}.`,
        range: { start: 0, end: 1 },
        severity: "error",
        fileName: resolvedRootDirectory
      }]
    };
  }
  return compileRsglProgram(files, compileOptions);
}

export function loadRsglSourceFilesFromFile(entryFileName: string, options: RsglFileLoadOptions = {}): RsglSourceFile[] {
  return new RsglWorkspaceSourceCache(options).loadProgramFromEntry(entryFileName);
}

export function loadRsglSourceFilesFromDirectory(rootDirectory: string, options: RsglFileLoadOptions = {}): RsglSourceFile[] {
  return new RsglWorkspaceSourceCache(options).loadProgramFromDirectory(rootDirectory);
}

export function compileRsglProgram(files: RsglSourceFile[], options: RsglProgramCompileOptions = {}): RsglCompileResult {
  const syntaxDiagnostics = files.flatMap(file => moduleSyntaxDiagnostics(file.module, file.fileName));
  if (hasErrors(syntaxDiagnostics)) {
    return { units: [], diagnostics: syntaxDiagnostics };
  }

  const program = semanticProgramMatchesFiles(options.semanticProgram, files)
    ? options.semanticProgram
    : bindRsglProgram(files);
  const units: ResourceUnit[] = [];
  const diagnostics: RsglCompileDiagnostic[] = [
    ...program.fileDiagnostics.map(diagnostic => ({ ...diagnostic }))
  ];
  const rawJsonLoader = createCompileRawJsonLoader(options.entryFileName ?? "<anonymous>", diagnostics);
  const globLoader = createCompileGlobLoader(options.entryFileName ?? "<anonymous>", diagnostics);
  const environments = createProgramCompileEnvironments(program, options.namespace, { rawJsonLoader, globLoader });
  const selectedModels = selectProgramModels(program, options.entryFileName);
  const target = resolveTargetPackFormat(selectedModels.map(model => ({
    module: model.module,
    namespace: options.namespace ?? model.namespace ?? "minecraft"
  })));

  if (options.entryFileName && selectedModels.length === 0) {
    diagnostics.push({
      code: "rsgl.compileMissingEntry",
      message: `RSGL entry file not found: ${options.entryFileName}.`,
      range: { start: 0, end: 1 },
      severity: "error",
      fileName: options.entryFileName
    });
  }

  for (const model of selectedModels) {
    const namespace = options.namespace ?? model.namespace ?? "minecraft";
    const environment = environments.get(normalizeFileName(model.fileName))
      ?? createStandaloneCompileEnvironment(model, namespace);
    const compiler = new RsglCompiler(model.module, {
      fileName: model.fileName,
      namespace,
      externalTemplates: Array.from(environment.importedTemplates.values()),
      externalFragments: Array.from(environment.importedFragments.values()),
      externalValues: mapToExternalValues(environment.importedValues),
      environment,
      rawJsonLoader,
      globLoader,
      targetPackFormat: target.targetPackFormat
    });
    const result = compiler.compile();
    units.push(...result.units);
    diagnostics.push(...result.diagnostics);
  }

  const lowered = lowerItemUnitsForTarget(units, target.targetPackFormat);
  const merged = mergeResourceUnits(lowered.units);
  const validationOptions = withTargetPackFormat(options, target.targetPackFormat);
  diagnostics.push(
    ...target.diagnostics,
    ...lowered.diagnostics,
    ...merged.diagnostics,
    ...detectOutputConflicts(merged.units),
    ...validateResourceUnits(merged.units, validationOptions)
  );
  return { units: merged.units, diagnostics };
}

export class RsglCompiler {
  private readonly units: ResourceUnit[] = [];
  private readonly diagnostics: RsglCompileDiagnostic[] = [];
  private readonly templates = new Map<string, RsglTemplateDefinition>();
  private readonly fragments = new Map<string, RsglFragmentDefinition>();
  private readonly overlayEntries: Array<{ entry: Record<string, JsonValue>; source: OverlayDeclNode; context: RsglCompileContext }> = [];

  public constructor(
    private readonly module: RsglModule,
    private readonly options: RsglCompilerOptions
  ) { }

  public compile(): RsglCompileResult {
    for (const template of this.options.externalTemplates ?? []) {
      this.templates.set(template.name, template);
    }
    for (const fragment of this.options.externalFragments ?? []) {
      this.fragments.set(fragment.name, fragment);
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
            this.templates,
            this.fragments
          );
        this.templates.set(statement.name.text, template);
      } else if (statement.kind === "FragmentDecl" && statement.name) {
        const fragment = this.options.environment?.allFragments.get(statement.name.text)
          ?? createFragmentDefinition(
            statement.name.text,
            statement,
            this.options.fileName,
            this.options.namespace,
            new Map(),
            this.templates,
            this.fragments
          );
        this.fragments.set(statement.name.text, fragment);
      }
    }
    const context = this.createRootContext();
    for (const statement of this.module.statements) {
      this.compileStatement(statement, context);
    }
    this.pushOverlayPackUnit();
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
    } else if (statement.kind === "OverlayDecl") {
      this.compileOverlayDecl(statement, context);
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
    } else if (statement.resourceKind === "pack") {
      this.pushUnit(this.compilePack(statement, context));
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
    const body = this.resourceBodyToObjectWithMappings(statement.body, context, this.resourceBodyFragmentOptions());
    return {
      id: modelId,
      kind: "model",
      outputPath,
      content: body.content,
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.sourceMap(outputPath, statement, context, body.mappings)
    };
  }

  private compileItem(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
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
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
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
      const iterable = evaluateExpression(statement.iterable, context);
      if (!Array.isArray(iterable)) {
        this.error("rsgl.compileNonFiniteLoop", "for input must evaluate to a finite list.", statement.iterable.range);
        return;
      }
      if (statement.body.kind !== "ResourceBody") {
        return;
      }
      for (const value of iterable) {
        const bindings = createLoopBindings(statement.bindings.map(binding => binding.text), value);
        const loopContent = this.compileBlockstateBody(statement.body, this.createLoopContext(context, bindings, statement.range));
        const multipartOffset = currentMultipartLength(result.content);
        mergeBlockstateContent(result.content, loopContent.content, statement.range, fragmentOptions);
        result.mappings.push(...offsetMultipartMappings(loopContent.mappings, multipartOffset));
      }
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
      const fragmentValue = compileBlockstateValueFragment(statement.value, context, this.blockstateFragmentOptions());
      result.entries[state] = fragmentValue?.handled
        ? fragmentValue.value
        : normalizeJsonValue(evaluateExpression(statement.value, context));
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
        this.compileVariantBody(statement.body, this.createLoopContext(context, bindings, statement.range), result);
      }
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
        this.compileMultipartBody(statement.body, this.createLoopContext(context, bindings, statement.range), result, startIndex);
      }
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
    const idValue = statement.id ? this.staticText(statement.id, context) : null;
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

  private compilePack(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit {
    const outputPath = "pack.mcmeta";
    const body = this.resourceBodyToObjectWithMappings(statement.body, context, this.packResourceBodyOptions());
    const hasExplicitPackRoot = isJsonObject(body.content.pack);
    const content = this.packContentWithTargetMetadata(packContentFromBody(body.content, hasExplicitPackRoot));
    return {
      kind: "pack",
      outputPath,
      content,
      mergePolicy: { kind: "mergeObject" },
      sourceMap: this.sourceMap(
        outputPath,
        statement,
        context,
        packSourceMappings(body.mappings, hasExplicitPackRoot)
      )
    };
  }

  private packContentWithTargetMetadata(content: Record<string, JsonValue>): Record<string, JsonValue> {
    if (!this.options.targetPackFormat || !isJsonObject(content.pack)) {
      return content;
    }
    const pack = content.pack;
    if ("pack_format" in pack || "supported_formats" in pack || "min_format" in pack || "max_format" in pack) {
      return content;
    }
    return {
      ...content,
      pack: {
        ...pack,
        ...packFormatMetadata(this.options.targetPackFormat)
      }
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
    const targetValue = statement.id ? this.staticText(statement.id, context) : null;
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
    const targetValue = statement.id ? this.staticText(statement.id, context) : null;
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

  private compileSugarDecl(statement: SugarDeclNode, context: RsglCompileContext): void {
    if (statement.sugarKind === "conventionalBlockstate") {
      this.compileConventionalBlockstateSugar(statement, context);
    } else if (statement.sugarKind === "family") {
      for (const unit of compileFamilySugar(statement, context, {
        onError: (code, message, range) => this.error(code, message, range)
      })) {
        this.pushUnit(unit);
      }
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
      this.pushUnit(createStairsBlockstate(
        idValue,
        context.namespace,
        context.sourceFile ?? this.options.fileName,
        statement.range,
        context.expansionStack ?? [],
        this.stairsSugarModels(statement, idValue, context)
      ));
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
    } else if (statement.sugarName.text === "pane") {
      this.pushUnit(createPaneBlockstate(idValue, context.namespace, context.sourceFile ?? this.options.fileName, statement.range, context.expansionStack ?? []));
    }
  }

  private stairsSugarModels(statement: SugarDeclNode, idValue: string, context: RsglCompileContext): { base: string; inner: string; outer: string } | undefined {
    const models = statement.options.find(option => option.name.text === "models")?.value;
    const pattern = models ? this.staticText(models, context) : null;
    if (!pattern) {
      return undefined;
    }
    const id = parseResourceId(idValue, context.namespace);
    if (!id) {
      return undefined;
    }
    const baseName = id.path;
    return {
      base: pattern.replaceAll("{id}", baseName),
      inner: pattern.replaceAll("{id}", `${baseName}_inner`),
      outer: pattern.replaceAll("{id}", `${baseName}_outer`)
    };
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
    const builtinUnits = compileBuiltinUse(expression, context, {
      sourceFile: context.sourceFile ?? this.options.fileName,
      expansionStack: context.expansionStack ?? [],
      onError: (code, message, range) => this.error(code, message, range)
    });
    if (builtinUnits) {
      builtinUnits.forEach(unit => this.pushUnit(unit));
      return;
    }

    const template = (context.templates ?? this.templates).get(expression.callee.name.text);
    if (!template) {
      return;
    }
    const recursionLabel = `use ${expression.callee.name.text}`;
    if ((context.expansionStack ?? []).some(frame => frame.label === recursionLabel)) {
      this.error("rsgl.templateRecursion", `Template '${template.name}' cannot recursively expand itself.`, expression.range);
      return;
    }
    const templateBaseContext = this.createTemplateBaseContext(template);
    const values: Record<string, EvaluationValue> = {};
    const parameters = template.node.parameters
      .filter(parameter => parameter.name)
      .map((parameter): TemplateCallParameter => ({
        name: parameter.name!.text,
        optional: Boolean(parameter.defaultValue),
        node: parameter,
        parameterNode: parameter
      }));
    const binding = bindRsglArguments(parameters, expression.args, {
      callRange: expression.range,
      codes: {
        duplicate: "rsgl.compileDuplicateArgument",
        missing: "rsgl.compileMissingArgument",
        tooMany: "rsgl.compileTooManyArguments",
        unknown: "rsgl.compileUnknownArgument"
      },
      messages: {
        duplicate: name => `Duplicate template argument '${name}'.`,
        missing: parameter => `Missing template argument '${parameter.name}'.`,
        tooMany: () => "Too many template positional arguments.",
        unknown: name => `Unknown template argument '${name}'.`
      }
    });
    this.diagnostics.push(...binding.diagnostics);
    const argsByParameter = new Map(binding.primaryAssignments.map(assignment => [assignment.parameter.name, assignment.arg]));

    for (const parameter of parameters) {
      const name = parameter.name;
      const arg = argsByParameter.get(name);
      if (arg) {
        values[name] = evaluateExpression(arg.value, context);
      } else if (parameter.parameterNode.defaultValue) {
        values[name] = evaluateExpression(parameter.parameterNode.defaultValue, this.createChildContext(templateBaseContext, values));
      }
    }
    const templateContext = this.createChildContext(templateBaseContext, values, {
      sourceFile: template.fileName,
      mappingReason: "template",
      expansionStack: [
        ...(context.expansionStack ?? []),
        { label: recursionLabel, sourceRange: expression.range }
      ]
    });
    templateContext.stateKeyAliases = this.callableStateKeyAliases(templateBaseContext, parameters);
    this.compileBlock(template.node.body, templateContext);
  }

  private compileResourceBodyFragment(
    useStatement: Extract<ResourceStatementNode, { kind: "UseDecl" }>,
    context: RsglCompileContext,
    kind?: "item" | JsonResourceFragmentKind
  ): ResourceBodyFragment | undefined {
    const expansion = this.createFragmentExpansion(useStatement, context);
    if (!expansion) {
      return undefined;
    }
    const body = this.resourceBodyToObjectWithRawMappings(
      expansion.definition.node.body,
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
    const builtInFragment = compileBlockstateUseFragment(useStatement, context, this.blockstateFragmentOptions());
    if (builtInFragment.variants || builtInFragment.multipart) {
      return builtInFragment;
    }
    return this.compileBlockstateUserFragment(useStatement, context) ?? {};
  }

  private compileBlockstateUserFragment(
    useStatement: UseDeclNode,
    context: RsglCompileContext
  ): RsglBlockstateFragment | undefined {
    const expansion = this.createFragmentExpansion(useStatement, context);
    if (!expansion) {
      return undefined;
    }
    const body = this.compileBlockstateBody(expansion.definition.node.body, expansion.context);
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

  private createFragmentExpansion(
    useStatement: UseDeclNode,
    context: RsglCompileContext
  ): FragmentExpansion | undefined {
    const expression = useStatement.expression;
    if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
      return undefined;
    }
    const fragmentName = expression.callee.name.text;
    const fragment = (context.fragments ?? this.fragments).get(fragmentName);
    if (!fragment) {
      return undefined;
    }
    const recursionKey = `fragment ${fragment.name}`;
    if ((context.expansionStack ?? []).some(frame => frame.label === recursionKey)) {
      this.error("rsgl.fragmentRecursion", `Fragment '${fragment.name}' cannot recursively expand itself.`, expression.range);
      return undefined;
    }

    const fragmentBaseContext = this.createFragmentBaseContext(fragment);
    const parameters = fragment.node.parameters
      .filter(parameter => parameter.name)
      .map((parameter): TemplateCallParameter => ({
        name: parameter.name!.text,
        optional: Boolean(parameter.defaultValue),
        node: parameter,
        parameterNode: parameter
      }));
    const values = this.bindCallableValues(
      parameters,
      expression,
      context,
      fragmentBaseContext,
      "fragment"
    );
    if (!values) {
      return undefined;
    }

    const fragmentContext = this.createChildContext(fragmentBaseContext, values, {
      sourceFile: fragment.fileName,
      mappingReason: "template",
      expansionStack: [
        ...(context.expansionStack ?? []),
        { label: recursionKey, sourceRange: expression.range }
      ]
    });
    fragmentContext.stateKeyAliases = this.callableStateKeyAliases(fragmentBaseContext, parameters);
    return { definition: fragment, context: fragmentContext };
  }

  private bindCallableValues(
    parameters: TemplateCallParameter[],
    expression: Extract<ExprNode, { kind: "CallExpr" }>,
    callContext: RsglCompileContext,
    definitionContext: RsglCompileContext,
    label: "template" | "fragment"
  ): Record<string, EvaluationValue> | null {
    const values: Record<string, EvaluationValue> = {};
    const binding = bindRsglArguments(parameters, expression.args, {
      callRange: expression.range,
      codes: {
        duplicate: "rsgl.compileDuplicateArgument",
        missing: "rsgl.compileMissingArgument",
        tooMany: "rsgl.compileTooManyArguments",
        unknown: "rsgl.compileUnknownArgument"
      },
      messages: {
        duplicate: name => `Duplicate ${label} argument '${name}'.`,
        missing: parameter => `Missing ${label} argument '${parameter.name}'.`,
        tooMany: () => `Too many ${label} positional arguments.`,
        unknown: name => `Unknown ${label} argument '${name}'.`
      }
    });
    this.diagnostics.push(...binding.diagnostics);
    if (binding.diagnostics.some(diagnostic => diagnostic.severity === "error")) {
      return null;
    }

    const argsByParameter = new Map(binding.primaryAssignments.map(assignment => [assignment.parameter.name, assignment.arg]));
    for (const parameter of parameters) {
      const name = parameter.name;
      const arg = argsByParameter.get(name);
      if (arg) {
        values[name] = evaluateExpression(arg.value, callContext);
      } else if (parameter.parameterNode.defaultValue) {
        values[name] = evaluateExpression(parameter.parameterNode.defaultValue, this.createChildContext(definitionContext, values));
      }
    }
    return values;
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

  private compileOverlayDecl(statement: OverlayDeclNode, context: RsglCompileContext): void {
    const directory = this.staticText(statement.directory, context);
    if (!directory || !/^[a-z0-9_-]+$/.test(directory)) {
      this.error("rsgl.invalidOverlayDirectory", "Overlay directory must contain only lowercase letters, numbers, '_' or '-'.", statement.directory.range);
      return;
    }

    const entry: Record<string, JsonValue> = { directory };
    if (statement.formatRange) {
      const range = this.overlayFormatRange(statement.formatRange, context);
      if (!range) {
        this.error("rsgl.invalidOverlayFormatRange", "Overlay format must be a number, [major, minor], or [min]..[max] range.", statement.formatRange.range);
        return;
      }
      entry.min_format = range.min;
      entry.max_format = range.max;
    }
    this.overlayEntries.push({ entry, source: statement, context });

    const startIndex = this.units.length;
    const overlayContext = this.createChildContext(context, {}, {
      expansionStack: [
        ...(context.expansionStack ?? []),
        { label: `overlay ${directory}`, sourceRange: statement.range }
      ]
    });
    this.compileBlock(statement.body, overlayContext);
    const overlayUnits = this.units.splice(startIndex);
    for (const unit of overlayUnits) {
      if (unit.outputPath === "pack.mcmeta") {
        this.error("rsgl.overlayPackMcmetaUnsupported", "Overlay blocks cannot emit pack.mcmeta directly.", unit.sourceMap.mappings[0]?.sourceRange ?? statement.range);
        continue;
      }
      this.units.push(prefixOverlayUnit(unit, directory));
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
      rawJsonLoader: this.options.rawJsonLoader,
      globLoader: this.options.globLoader,
      templates: this.templates,
      fragments: this.fragments
    };
  }

  private createTemplateBaseContext(template: RsglTemplateDefinition): RsglCompileContext {
    return {
      namespace: template.namespace,
      variables: new Map(template.values),
      sourceFile: template.fileName,
      mappingReason: "template",
      expansionStack: [],
      rawJsonLoader: this.options.rawJsonLoader,
      globLoader: this.options.globLoader,
      templates: template.templates,
      fragments: template.fragments
    };
  }

  private createFragmentBaseContext(fragment: RsglFragmentDefinition): RsglCompileContext {
    return {
      namespace: fragment.namespace,
      variables: new Map(fragment.values),
      sourceFile: fragment.fileName,
      mappingReason: "template",
      expansionStack: [],
      rawJsonLoader: this.options.rawJsonLoader,
      globLoader: this.options.globLoader,
      templates: fragment.templates,
      fragments: fragment.fragments
    };
  }

  private createChildContext(
    context: RsglCompileContext,
    values: Record<string, EvaluationValue>,
    metadata: Partial<Pick<EvaluationContext, "sourceFile" | "mappingReason" | "expansionStack">> = {}
  ): RsglCompileContext {
    return {
      ...childEvaluationContext(context, values, metadata),
      templates: context.templates,
      fragments: context.fragments
    };
  }

  private createLoopContext(
    context: RsglCompileContext,
    bindings: Record<string, EvaluationValue>,
    sourceRange: { start: number; end: number }
  ): RsglCompileContext {
    return {
      ...createEvaluationLoopContext(context, bindings, sourceRange),
      templates: context.templates,
      fragments: context.fragments
    };
  }

  private callableStateKeyAliases(
    context: RsglCompileContext,
    parameters: TemplateCallParameter[]
  ): ReadonlySet<string> {
    return new Set([
      ...(context.stateKeyAliases ?? []),
      ...parameters.map(parameter => parameter.name)
    ]);
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

  private resourceBodyFragmentOptions(kind?: "item" | JsonResourceFragmentKind): ResourceBodyCompileOptions {
    return {
      onUseFragment: (useStatement, fragmentContext) => {
        if (kind === "item") {
          return createResourceBodyFragment(compileItemUseFragment(useStatement, fragmentContext, this.itemFragmentOptions()))
            ?? this.compileResourceBodyFragment(useStatement, fragmentContext, kind);
        }
        if (kind) {
          return compileJsonResourceUseFragment(kind, useStatement, fragmentContext, {
            onError: (code, message, range) => this.error(code, message, range)
          })
            ?? this.compileResourceBodyFragment(useStatement, fragmentContext, kind);
        }
        return this.compileResourceBodyFragment(useStatement, fragmentContext, kind);
      },
      onSpecialStatement: (statement, fragmentContext) =>
        kind === "item" && isItemModelStatement(statement)
          ? compileItemSpecialStatement(statement, fragmentContext, this.itemFragmentOptions())
          : undefined
    };
  }

  private packResourceBodyOptions(): ResourceBodyCompileOptions {
    return {
      ...this.resourceBodyFragmentOptions(),
      onSpecialStatement: (statement, context) => this.compilePackSpecialStatement(statement, context)
    };
  }

  private compilePackSpecialStatement(statement: ResourceStatementNode, context: RsglCompileContext): Record<string, JsonValue> | undefined {
    if (statement.kind === "PackFormatsStmt") {
      return this.compilePackFormatsStatement(statement, context);
    }
    if (statement.kind === "PackOverlayStmt") {
      return this.compilePackOverlayStatement(statement, context);
    }
    if (statement.kind === "PackFilterBlockStmt") {
      return this.compilePackFilterBlockStatement(statement, context);
    }
    return undefined;
  }

  private compilePackFormatsStatement(statement: PackFormatsStmtNode, context: RsglCompileContext): Record<string, JsonValue> {
    const result: Record<string, JsonValue> = {};
    if (statement.min) {
      const min = this.packFormatValue(statement.min, context);
      if (min) {
        result.min_format = min;
      } else {
        this.error("rsgl.invalidPackFormatField", "Pack formats min must be a number or [major, minor] tuple.", statement.min.range);
      }
    }
    if (statement.max) {
      const max = this.packFormatValue(statement.max, context);
      if (max) {
        result.max_format = max;
      } else {
        this.error("rsgl.invalidPackFormatField", "Pack formats max must be a number or [major, minor] tuple.", statement.max.range);
      }
    }
    return result;
  }

  private compilePackOverlayStatement(statement: PackOverlayStmtNode, context: RsglCompileContext): Record<string, JsonValue> | undefined {
    const directory = this.staticText(statement.directory, context);
    if (!directory) {
      this.error("rsgl.invalidOverlayDirectory", "Pack overlay directory must be a static string.", statement.directory.range);
      return undefined;
    }
    const body = this.resourceBodyToObject(statement.body, context, this.packResourceBodyOptions());
    return {
      overlays: {
        entries: [{
          directory,
          ...body
        }]
      }
    };
  }

  private compilePackFilterBlockStatement(statement: PackFilterBlockStmtNode, context: RsglCompileContext): Record<string, JsonValue> | undefined {
    const namespace = statement.namespace ? this.staticText(statement.namespace, context) : null;
    const path = statement.path ? this.staticText(statement.path, context) : null;
    if (!namespace || !path) {
      this.error("rsgl.invalidPackFilterBlock", "Pack filter block requires static namespace and path patterns.", statement.range);
      return undefined;
    }
    return {
      block: [{
        namespace,
        path
      }]
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

  private overlayFormatRange(expression: ExprNode, context: RsglCompileContext): { min: JsonValue[]; max: JsonValue[] } | null {
    if (expression.kind === "RangeExpr") {
      const min = this.packFormatValue(expression.startExpr, context);
      const max = this.packFormatValue(expression.endExpr, context);
      return min && max ? { min, max } : null;
    }
    const value = this.packFormatValue(expression, context);
    return value ? { min: value, max: value } : null;
  }

  private packFormatValue(expression: ExprNode, context: RsglCompileContext): JsonValue[] | null {
    const value = evaluateExpression(expression, context);
    if (typeof value === "number" && Number.isFinite(value)) {
      return [value, 0];
    }
    if (Array.isArray(value) && typeof value[0] === "number") {
      return [value[0], typeof value[1] === "number" ? value[1] : 0];
    }
    return null;
  }

  private pushOverlayPackUnit(): void {
    if (this.overlayEntries.length === 0) {
      return;
    }
    const outputPath = "pack.mcmeta";
    this.units.push({
      kind: "pack",
      outputPath,
      content: {
        overlays: {
          entries: this.overlayEntries.map(item => item.entry)
        }
      },
      mergePolicy: { kind: "mergeObject" },
      sourceMap: {
        generatedFile: outputPath,
        mappings: this.overlayEntries.map((item, index) => ({
          generatedPath: appendGeneratedPath("/overlays/entries", String(index)),
          sourceFile: item.context.sourceFile ?? this.options.fileName,
          sourceRange: item.source.range,
          reason: item.context.mappingReason ?? "direct",
          expansionStack: item.context.expansionStack ?? []
        }))
      }
    });
  }
}

