import type { ExternResourceSource } from "../externDeclarations";
import { visitExternalModelReferences, type RsglExternalModelDocument } from "./externalModelReferences";
import type { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { modelDocumentFromUnit, type ModelDocument, type ModelResolver } from "./modelDocuments";
import { canonicalizeResourceReference } from "./resourceReferenceConsumers";
import {
  checkInheritedExternalResourceExists,
  checkResourceExists
} from "./resourceReferenceValidation";
import { appendGeneratedPath } from "./sourcePaths";
import { visitJsonWithPath } from "./jsonValues";
import {
  pushDiagnosticAtRange,
  sourceFileForValidationRange,
  sourceRangeForGeneratedPath
} from "./validationDiagnostics";
import { asObject } from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";

type TextureVariableResolution =
  | {
    kind: "resolved";
    texture: string;
    source?: ExternResourceSource;
    generatedUnit?: ResourceUnit;
    generatedPath?: string;
    defaultNamespace: string;
  }
  | { kind: "missing"; name: string }
  | { kind: "cycle" };

export function validateLoadedExternalModelReferences(
  unit: ResourceUnit,
  concreteRoot: ModelDocument | undefined,
  documents: Iterable<RsglExternalModelDocument>,
  modelResolver: ModelResolver,
  externalModelSources: ReadonlyMap<string, ExternResourceSource>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (!concreteRoot) {
    return;
  }
  const range = sourceRangeForGeneratedPath(unit, "/parent");
  const checkedResources = new Set<string>();
  const checkedVariables = new Set<string>();
  const externalVariables = new Set(unit.validation?.externalTextureVariables ?? []);
  visitExternalModelReferences(documents, {
    resource: (document, consumer, rawValue) => {
      const reference = canonicalizeResourceReference(consumer, rawValue, document.namespace);
      const key = reference.kind === "resource"
        ? `${document.externalSource}\0${reference.targetKind}\0${reference.lookupId}`
        : `${document.externalSource}\0${document.namespace}\0${consumer}\0${rawValue}`;
      if (checkedResources.has(key)) {
        return;
      }
      checkedResources.add(key);
      checkInheritedExternalResourceExists(
        consumer,
        rawValue,
        document.externalSource,
        unit,
        options,
        diagnostics,
        range,
        true,
        document.namespace
      );
    },
    textureVariable: (_document, name) => {
      if (checkedVariables.has(name)) {
        return;
      }
      checkedVariables.add(name);
      const resolution = resolveTextureVariable(
        concreteRoot,
        name,
        modelResolver,
        externalModelSources,
        new Set()
      );
      validateExternalTextureVariableResolution(
        name,
        resolution,
        unit,
        options,
        diagnostics,
        range,
        externalVariables
      );
    }
  });
}

export function validateModelTextureVariables(
  unit: ResourceUnit,
  modelResolver: ModelResolver,
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
      pushDiagnosticAtRange(
        diagnostics,
        "rsgl.unresolvedTextureVariable",
        `Texture variable '#${reference}' is not defined in the model parent chain.`,
        "warning",
        range
      );
    } else if (resolution.kind === "cycle") {
      pushDiagnosticAtRange(
        diagnostics,
        "rsgl.textureVariableCycle",
        `Texture variable '#${reference}' resolves through a cycle.`,
        "error",
        range
      );
    } else if (resolution.source) {
      checkTransitiveTextureExists(
        resolution.texture,
        resolution.defaultNamespace,
        resolution.source,
        unit,
        options,
        diagnostics,
        range
      );
    } else {
      const externScopeFile = resolution.generatedUnit && resolution.generatedPath
        ? sourceFileForValidationRange(
          resolution.generatedUnit,
          sourceRangeForGeneratedPath(resolution.generatedUnit, resolution.generatedPath)
        )
        : undefined;
      checkResourceExists(
        "modelTexture",
        resolution.texture,
        unit,
        options,
        diagnostics,
        range,
        externScopeFile,
        resolution.defaultNamespace
      );
    }
  });
}

function validateExternalTextureVariableResolution(
  reference: string,
  resolution: TextureVariableResolution,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  range: { start: number; end: number },
  externalVariables: ReadonlySet<string>
): void {
  if (resolution.kind === "missing") {
    if (externalVariables.has(resolution.name)) {
      return;
    }
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.unresolvedTextureVariable",
      `Texture variable '#${reference}' is not defined in the model parent chain.`,
      "warning",
      range
    );
    return;
  }
  if (resolution.kind === "cycle") {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.textureVariableCycle",
      `Texture variable '#${reference}' resolves through a cycle.`,
      "error",
      range
    );
    return;
  }
  if (resolution.source) {
    checkTransitiveTextureExists(
      resolution.texture,
      resolution.defaultNamespace,
      resolution.source,
      unit,
      options,
      diagnostics,
      range
    );
    return;
  }
  checkResourceExists(
    "modelTexture",
    resolution.texture,
    unit,
    options,
    diagnostics,
    range,
    undefined,
    resolution.defaultNamespace
  );
}

function checkTransitiveTextureExists(
  id: string,
  defaultNamespace: string,
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
    true,
    defaultNamespace
  );
}

function resolveTextureVariable(
  model: ModelDocument,
  name: string,
  modelResolver: ModelResolver,
  externalModelSources: ReadonlyMap<string, ExternResourceSource>,
  seen: Set<string>,
  lookupRoot: ModelDocument = model
): TextureVariableResolution {
  const resolutionKey = `${model.id}#${name}`;
  if (seen.has(resolutionKey)) {
    return { kind: "cycle" };
  }
  seen.add(resolutionKey);

  const textures = asObject(model.content.textures);
  if (textures && Object.hasOwn(textures, name)) {
    return resolveTextureValue(
      textures[name],
      name,
      model,
      modelResolver,
      externalModelSources,
      seen,
      lookupRoot
    );
  }

  const parentReference = typeof model.content.parent === "string"
    ? canonicalizeResourceReference("model", model.content.parent, model.namespace)
    : undefined;
  const parentId = parentReference?.kind === "resource" ? parentReference.id : undefined;
  const parentSource = parentId ? model.externalSource ?? externalModelSources.get(parentId) : undefined;
  const parentModel = parentId ? modelResolver(parentId, parentSource) : undefined;
  return parentModel
    ? resolveTextureVariable(parentModel, name, modelResolver, externalModelSources, seen, lookupRoot)
    : { kind: "missing", name };
}

function resolveTextureValue(
  value: JsonValue | undefined,
  name: string,
  model: ModelDocument,
  modelResolver: ModelResolver,
  externalModelSources: ReadonlyMap<string, ExternResourceSource>,
  seen: Set<string>,
  lookupRoot: ModelDocument
): TextureVariableResolution {
  if (typeof value === "string") {
    return value.startsWith("#")
      ? resolveTextureVariable(lookupRoot, value.slice(1), modelResolver, externalModelSources, seen, lookupRoot)
      : resolvedTexture(value, name, model);
  }

  const object = asObject(value);
  if (typeof object?.sprite === "string") {
    return object.sprite.startsWith("#")
      ? resolveTextureVariable(
        lookupRoot,
        object.sprite.slice(1),
        modelResolver,
        externalModelSources,
        seen,
        lookupRoot
      )
      : resolvedTexture(object.sprite, name, model, "sprite");
  }

  return { kind: "missing", name: "" };
}

function resolvedTexture(
  texture: string,
  name: string,
  model: ModelDocument,
  childPath?: string
): TextureVariableResolution {
  const texturePath = appendGeneratedPath("/textures", name);
  return {
    kind: "resolved",
    texture,
    source: model.externalSource,
    generatedUnit: model.generatedUnit,
    generatedPath: childPath ? appendGeneratedPath(texturePath, childPath) : texturePath,
    defaultNamespace: model.namespace
  };
}

function textureVariableReference(value: JsonValue): string | null {
  return typeof value === "string" && value.startsWith("#") && value.length > 1
    ? value.slice(1)
    : null;
}
