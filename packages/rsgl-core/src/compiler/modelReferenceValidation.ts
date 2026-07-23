import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import type { ExternResourceSource } from "../externDeclarations";
import { validateModelStructure } from "./modelStructureValidation";
import { appendGeneratedPath } from "./sourcePaths";
import {
  checkInheritedExternalResourceExists,
  isVirtualBuiltinModelId
} from "./resourceReferenceValidation";
import { checkJsonResourceReference } from "./jsonResourceReferenceValidation";
import {
  pushDiagnosticAtRange,
  sourceRangeForGeneratedPath
} from "./validationDiagnostics";
import { asObject } from "./validationPrimitives";
import { isJsonObject } from "./jsonValues";
import type { RsglResourceValidationOptions } from "./validationTypes";
import { canonicalizeResourceReference } from "./resourceReferenceConsumers";
import type { RsglExternalModelDocument } from "./externalModelReferences";
import { modelDocumentFromUnit, type ModelDocument, type ModelResolver } from "./modelDocuments";
import {
  validateLoadedExternalModelReferences,
  validateModelTextureVariables
} from "./modelTextureVariableValidation";

export function validateModelUnit(
  unit: ResourceUnit,
  modelResolver: (id: string) => ModelDocument | undefined,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const externalModelSources = new Map<string, ExternResourceSource>();
  const externalDocuments = new Map<string, RsglExternalModelDocument>();
  validateModelParentChain(
    unit,
    modelResolver,
    externalModelSources,
    externalDocuments,
    options,
    diagnostics
  );
  validateLoadedExternalModelReferences(
    unit,
    modelDocumentFromUnit(unit),
    externalDocuments.values(),
    modelResolver,
    externalModelSources,
    options,
    diagnostics
  );

  const content = asObject(unit.content);
  const textures = asObject(content?.textures);
  if (textures) {
    for (const [key, value] of Object.entries(textures)) {
      const texturePath = appendGeneratedPath("/textures", key);
      if (typeof value === "string") {
        checkJsonResourceReference(
          textures,
          key,
          "modelTexture",
          unit,
          options,
          diagnostics,
          texturePath
        );
      } else if (isJsonObject(value) && typeof value.sprite === "string") {
        checkJsonResourceReference(
          value,
          "sprite",
          "modelTexture",
          unit,
          options,
          diagnostics,
          appendGeneratedPath(texturePath, "sprite")
        );
      }
    }
  }
  validateModelFaceTextureReferences(unit, content, options, diagnostics);

  validateLegacyItemOverrides(unit, content, options, diagnostics);

  validateModelTextureVariables(unit, modelResolver, externalModelSources, options, diagnostics);
  validateModelStructure(unit, diagnostics);
}

function validateModelFaceTextureReferences(
  unit: ResourceUnit,
  content: Record<string, JsonValue> | null,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const elements = Array.isArray(content?.elements) ? content.elements : [];
  for (const [elementIndex, elementValue] of elements.entries()) {
    const faces = asObject(asObject(elementValue)?.faces);
    if (!faces) {
      continue;
    }
    for (const [faceName, faceValue] of Object.entries(faces)) {
      const face = asObject(faceValue);
      if (typeof face?.texture !== "string") {
        continue;
      }
      const texturePath = appendGeneratedPath(
        appendGeneratedPath(
          appendGeneratedPath(appendGeneratedPath("/elements", String(elementIndex)), "faces"),
          faceName
        ),
        "texture"
      );
      checkJsonResourceReference(
        face,
        "texture",
        "modelTexture",
        unit,
        options,
        diagnostics,
        texturePath
      );
    }
  }
}

function validateLegacyItemOverrides(
  unit: ResourceUnit,
  content: Record<string, JsonValue> | null,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const overrides = Array.isArray(content?.overrides) ? content.overrides : [];
  for (const [index, value] of overrides.entries()) {
    const override = asObject(value);
    if (typeof override?.model !== "string") {
      continue;
    }
    const modelPath = appendGeneratedPath(appendGeneratedPath("/overrides", String(index)), "model");
    checkJsonResourceReference(
      override,
      "model",
      "model",
      unit,
      options,
      diagnostics,
      modelPath
    );
  }
}

function validateModelParentChain(
  unit: ResourceUnit,
  modelResolver: ModelResolver,
  externalModelSources: Map<string, ExternResourceSource>,
  externalDocuments: Map<string, RsglExternalModelDocument>,
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
    if (current.externalSource) {
      externalDocuments.set(`${current.externalSource}\0${current.id}`, {
        id: current.id,
        namespace: current.namespace,
        content: current.content,
        externalSource: current.externalSource
      });
    }
    if (seen.has(current.id)) {
      pushDiagnosticAtRange(
        diagnostics,
        "rsgl.modelParentCycle",
        `Model parent chain contains a cycle at ${current.id}.`,
        "error",
        unit.sourceMap.mappings[0].sourceRange
      );
      return;
    }
    seen.add(current.id);

    const parent = current.content.parent;
    if (typeof parent !== "string") {
      return;
    }
    if (current.externalSource) {
      const reference = canonicalizeResourceReference("model", parent, current.namespace);
      if (reference.kind !== "resource") {
        checkInheritedExternalResourceExists(
          "model",
          parent,
          current.externalSource,
          unit,
          options,
          diagnostics,
          sourceRangeForGeneratedPath(unit, "/parent"),
          false,
          current.namespace
        );
        return;
      }
      const parentId = reference.id;
      current = resolveTransitiveExternalModel(
        parentId,
        current.namespace,
        current.externalSource,
        unit,
        modelResolver,
        options,
        diagnostics
      );
      if (current?.externalSource) {
        externalModelSources.set(parentId, current.externalSource);
      }
      continue;
    }

    const referencingUnit = current.generatedUnit ?? unit;
    const checked = checkJsonResourceReference(
      current.content,
      "parent",
      "model",
      referencingUnit,
      options,
      diagnostics,
      "/parent",
      undefined,
      current.namespace
    );
    const parentId = checked.canonicalId;
    if (!checked.available || !parentId || isVirtualBuiltinModelId(parentId)) {
      return;
    }
    if (checked.source) {
      externalModelSources.set(parentId, checked.source);
      current = modelResolver(parentId, checked.source);
    } else {
      current = modelResolver(parentId);
    }
  }
}

function resolveTransitiveExternalModel(
  id: string,
  defaultNamespace: string,
  source: ExternResourceSource,
  unit: ResourceUnit,
  modelResolver: ModelResolver,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): ModelDocument | undefined {
  const document = options.resourceResolution
    ? modelResolver(id)
    : modelResolver(id, source);
  const exists = checkInheritedExternalResourceExists(
    "model",
    id,
    source,
    unit,
    options,
    diagnostics,
    sourceRangeForGeneratedPath(unit, "/parent"),
    document !== undefined,
    defaultNamespace
  );
  if (exists) {
    return document;
  }
  return undefined;
}
