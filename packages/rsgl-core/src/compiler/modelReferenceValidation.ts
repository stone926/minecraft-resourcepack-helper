import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import type { ExternResourceSource } from "../externDeclarations";
import { validateModelStructure } from "./modelStructureValidation";
import { appendGeneratedPath } from "./sourcePaths";
import {
  asObject,
  checkInheritedExternalResourceExists,
  checkResourceExists,
  isObject,
  isVirtualBuiltinModelId,
  sourceFileForValidationRange,
  sourceRangeForGeneratedPath,
  visitJsonWithPath,
  type RsglResourceValidationOptions
} from "./validationShared";
import { qualifyMinecraftResourceId, tryParseMinecraftResourceId } from "../../../mc-assets/src";

type TextureVariableResolution =
  | {
    kind: "resolved";
    texture: string;
    source?: ExternResourceSource;
    generatedUnit?: ResourceUnit;
    generatedPath?: string;
  }
  | { kind: "missing"; name: string }
  | { kind: "cycle" };

export interface ModelDocument {
  id: string;
  namespace: string;
  content: Record<string, JsonValue>;
  externalSource?: ExternResourceSource;
  generatedUnit?: ResourceUnit;
}

type ModelResolver = (id: string, source?: ExternResourceSource) => ModelDocument | undefined;

export function validateModelUnit(
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  modelResolver: (id: string) => ModelDocument | undefined,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const externalModelSources = new Map<string, ExternResourceSource>();
  validateModelParentChain(unit, modelResolver, generatedModels, externalModelSources, options, diagnostics);

  const content = asObject(unit.content);
  const textures = asObject(content?.textures);
  if (textures) {
    for (const [key, value] of Object.entries(textures)) {
      const texturePath = appendGeneratedPath("/textures", key);
      if (typeof value === "string" && !value.startsWith("#")) {
        checkResourceExists("texture", value, unit, generatedModels, options, diagnostics, sourceRangeForGeneratedPath(unit, texturePath));
      } else if (isObject(value) && typeof value.sprite === "string" && !value.sprite.startsWith("#")) {
        checkResourceExists(
          "texture",
          value.sprite,
          unit,
          generatedModels,
          options,
          diagnostics,
          sourceRangeForGeneratedPath(unit, appendGeneratedPath(texturePath, "sprite"))
        );
      }
    }
  }

  validateLegacyItemOverrides(unit, content, generatedModels, options, diagnostics);

  validateModelTextureVariables(unit, modelResolver, generatedModels, externalModelSources, options, diagnostics);
  validateModelStructure(unit, diagnostics);
}

function validateLegacyItemOverrides(
  unit: ResourceUnit,
  content: Record<string, JsonValue> | null,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const overrides = Array.isArray(content?.overrides) ? content.overrides : [];
  const namespace = unit.id?.namespace ?? "minecraft";
  for (const [index, value] of overrides.entries()) {
    const override = asObject(value);
    if (typeof override?.model !== "string") {
      continue;
    }
    const modelPath = appendGeneratedPath(appendGeneratedPath("/overrides", String(index)), "model");
    checkResourceExists(
      "model",
      qualifyMinecraftResourceId(override.model, namespace),
      unit,
      generatedModels,
      options,
      diagnostics,
      sourceRangeForGeneratedPath(unit, modelPath)
    );
  }
}

export function createModelResolver(
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions
): ModelResolver {
  const generatedDocuments = new Map<string, ModelDocument>();
  const externalDocuments = new Map<string, ModelDocument | null>();

  return (id, source) => {
    if (isVirtualBuiltinModelId(id)) {
      return undefined;
    }

    const generated = generatedModels.get(id);
    if (generated) {
      let document = generatedDocuments.get(id);
      if (!document) {
        document = modelDocumentFromUnit(generated);
        if (!document) {
          return undefined;
        }
        generatedDocuments.set(id, document);
      }
      return document;
    }

    const contentReader = source && options.externResourceContent
      ? (resourceId: string) => options.externResourceContent!(source, "model", resourceId)
      : source && options.resourceContent
        ? (resourceId: string) => options.resourceContent!("model", resourceId)
        : undefined;
    if (!contentReader) {
      return undefined;
    }
    const cacheKey = `${source ?? "generic"}\0${id}`;
    if (!externalDocuments.has(cacheKey)) {
      const content = contentReader(id);
      const contentObject = asObject(content);
      externalDocuments.set(cacheKey, contentObject ? modelDocumentFromContent(id, contentObject, source) : null);
    }
    return externalDocuments.get(cacheKey) ?? undefined;
  };
}

function validateModelParentChain(
  unit: ResourceUnit,
  modelResolver: ModelResolver,
  generatedModels: Map<string, ResourceUnit>,
  externalModelSources: Map<string, ExternResourceSource>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const root = modelDocumentFromUnit(unit);
  if (!root) {
    return;
  }

  const seen = new Set<string>();
  let current: ModelDocument | undefined = root;
  while (current) {
    if (seen.has(current.id)) {
      diagnostics.push({
        code: "rsgl.modelParentCycle",
        message: `Model parent chain contains a cycle at ${current.id}.`,
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
      return;
    }
    seen.add(current.id);

    const parent = current.content.parent;
    if (typeof parent !== "string") {
      return;
    }
    const parentId = qualifyMinecraftResourceId(parent, current.namespace);
    if (isVirtualBuiltinModelId(parentId)) {
      return;
    }

    if (generatedModels.has(parentId)) {
      current = modelResolver(parentId);
      continue;
    }

    if (current.externalSource) {
      current = resolveTransitiveExternalModel(
        parentId,
        current.externalSource,
        unit,
        modelResolver,
        options,
        diagnostics
      );
      if (current) {
        externalModelSources.set(parentId, current.externalSource!);
      }
      continue;
    }

    const referencingUnit = current.generatedUnit ?? unit;
    const range = sourceRangeForGeneratedPath(referencingUnit, "/parent");
    const checked = checkResourceExists(
      "model",
      parentId,
      referencingUnit,
      generatedModels,
      options,
      diagnostics,
      range
    );
    if (!checked.available || !checked.source) {
      return;
    }
    externalModelSources.set(parentId, checked.source);
    current = modelResolver(parentId, checked.source);
  }
}

function resolveTransitiveExternalModel(
  id: string,
  source: ExternResourceSource,
  unit: ResourceUnit,
  modelResolver: ModelResolver,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): ModelDocument | undefined {
  const document = modelResolver(id, source);
  const exists = checkInheritedExternalResourceExists(
    "model",
    id,
    source,
    unit,
    options,
    diagnostics,
    sourceRangeForGeneratedPath(unit, "/parent"),
    document !== undefined
  );
  if (exists) {
    return document;
  }
  return undefined;
}

function validateModelTextureVariables(
  unit: ResourceUnit,
  modelResolver: ModelResolver,
  generatedModels: Map<string, ResourceUnit>,
  externalModelSources: ReadonlyMap<string, ExternResourceSource>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const root = modelDocumentFromUnit(unit);
  if (!root) {
    return;
  }

  const checked = new Set<string>();
  const externalVariables = new Set(unit.validation?.externalTextureVariables ?? []);
  visitJsonWithPath(unit.content as JsonValue, (value, generatedPath) => {
    const reference = textureVariableReference(value);
    if (!reference || checked.has(reference)) {
      return;
    }
    checked.add(reference);

    const range = sourceRangeForGeneratedPath(unit, generatedPath);
    const resolution = resolveTextureVariable(root, reference, modelResolver, externalModelSources, new Set());
    if (resolution.kind === "missing") {
      if (externalVariables.has(resolution.name)) {
        return;
      }
      diagnostics.push({
        code: "rsgl.unresolvedTextureVariable",
        message: `Texture variable '#${reference}' is not defined in the model parent chain.`,
        severity: "warning",
        range
      });
    } else if (resolution.kind === "cycle") {
      diagnostics.push({
        code: "rsgl.textureVariableCycle",
        message: `Texture variable '#${reference}' resolves through a cycle.`,
        severity: "error",
        range
      });
    } else {
      if (resolution.source) {
        checkTransitiveTextureExists(resolution.texture, resolution.source, unit, options, diagnostics, range);
      } else {
        const externScopeFile = resolution.generatedUnit && resolution.generatedPath
          ? sourceFileForValidationRange(
            resolution.generatedUnit,
            sourceRangeForGeneratedPath(resolution.generatedUnit, resolution.generatedPath)
          )
          : undefined;
        checkResourceExists(
          "texture",
          resolution.texture,
          unit,
          generatedModels,
          options,
          diagnostics,
          range,
          externScopeFile
        );
      }
    }
  });
}

function checkTransitiveTextureExists(
  id: string,
  source: ExternResourceSource,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  range: { start: number; end: number }
): void {
  checkInheritedExternalResourceExists(
    "texture",
    id,
    source,
    unit,
    options,
    diagnostics,
    range,
    true
  );
}

function modelDocumentFromUnit(unit: ResourceUnit): ModelDocument | undefined {
  const id = modelKey(unit);
  const content = asObject(unit.content);
  return id && content ? modelDocumentFromContent(id, content, undefined, unit) : undefined;
}

function modelDocumentFromContent(
  id: string,
  content: Record<string, JsonValue>,
  externalSource?: ExternResourceSource,
  generatedUnit?: ResourceUnit
): ModelDocument {
  return {
    id,
    namespace: tryParseMinecraftResourceId(id, "minecraft")?.namespace ?? "minecraft",
    content,
    externalSource,
    generatedUnit
  };
}

function resolveTextureVariable(
  model: ModelDocument,
  name: string,
  modelResolver: ModelResolver,
  externalModelSources: ReadonlyMap<string, ExternResourceSource>,
  seen: Set<string>
): TextureVariableResolution {
  const resolutionKey = `${model.id}#${name}`;
  if (seen.has(resolutionKey)) {
    return { kind: "cycle" };
  }
  seen.add(resolutionKey);

  const content = model.content;
  const textures = asObject(content.textures);
  if (textures && Object.hasOwn(textures, name)) {
    return resolveTextureValue(textures[name], name, model, modelResolver, externalModelSources, seen);
  }

  const parent = content.parent;
  const parentId = typeof parent === "string"
    ? qualifyMinecraftResourceId(parent, model.namespace)
    : undefined;
  const parentSource = parentId ? model.externalSource ?? externalModelSources.get(parentId) : undefined;
  const parentModel = parentId ? modelResolver(parentId, parentSource) : undefined;
  return parentModel
    ? resolveTextureVariable(parentModel, name, modelResolver, externalModelSources, seen)
    : { kind: "missing", name };
}

function resolveTextureValue(
  value: JsonValue | undefined,
  name: string,
  model: ModelDocument,
  modelResolver: ModelResolver,
  externalModelSources: ReadonlyMap<string, ExternResourceSource>,
  seen: Set<string>
): TextureVariableResolution {
  if (typeof value === "string") {
    return value.startsWith("#")
      ? resolveTextureVariable(model, value.slice(1), modelResolver, externalModelSources, seen)
      : {
        kind: "resolved",
        texture: value,
        source: model.externalSource,
        generatedUnit: model.generatedUnit,
        generatedPath: appendGeneratedPath("/textures", name)
      };
  }

  const object = asObject(value);
  if (typeof object?.sprite === "string") {
    return object.sprite.startsWith("#")
      ? resolveTextureVariable(model, object.sprite.slice(1), modelResolver, externalModelSources, seen)
      : {
        kind: "resolved",
        texture: object.sprite,
        source: model.externalSource,
        generatedUnit: model.generatedUnit,
        generatedPath: appendGeneratedPath(appendGeneratedPath("/textures", name), "sprite")
      };
  }

  return { kind: "missing", name: "" };
}

function textureVariableReference(value: JsonValue): string | null {
  return typeof value === "string" && value.startsWith("#") && value.length > 1
    ? value.slice(1)
    : null;
}

function modelKey(unit: ResourceUnit): string | null {
  return unit.id ? `${unit.id.namespace}:${unit.id.path}` : null;
}
