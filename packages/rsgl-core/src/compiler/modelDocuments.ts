import { tryParseMinecraftResourceId } from "../../../mc-assets/src";
import type { ExternResourceSource } from "../externDeclarations";
import type { JsonValue, ResourceUnit } from "./ir";
import { isVirtualBuiltinModelId } from "./resourceReferenceValidation";
import { asObject } from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";

export interface ModelDocument {
  id: string;
  namespace: string;
  content: Record<string, JsonValue>;
  externalSource?: ExternResourceSource;
  generatedUnit?: ResourceUnit;
}

export type ModelResolver = (id: string, source?: ExternResourceSource) => ModelDocument | undefined;

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

    const effectiveSource = source
      ? undefined
      : options.resourceResolution?.("model", id)?.source;
    let contentReader: ((resourceId: string) => JsonValue | null | undefined) | undefined;
    if (source && options.externResourceContent) {
      contentReader = resourceId => options.externResourceContent!(source, "model", resourceId);
    } else if (source && options.resourceContent) {
      contentReader = resourceId => options.resourceContent!("model", resourceId);
    } else if (effectiveSource && options.externResourceContent) {
      contentReader = resourceId => options.externResourceContent!(effectiveSource, "model", resourceId);
    } else if (options.resourceContent) {
      contentReader = resourceId => options.resourceContent!("model", resourceId);
    }
    if (!contentReader) {
      return undefined;
    }
    const cacheKey = `${source ?? "effective"}\0${id}`;
    if (!externalDocuments.has(cacheKey)) {
      const content = contentReader(id);
      const contentObject = asObject(content);
      externalDocuments.set(
        cacheKey,
        contentObject ? modelDocumentFromContent(id, contentObject, source ?? effectiveSource) : null
      );
    }
    return externalDocuments.get(cacheKey) ?? undefined;
  };
}

export function modelDocumentFromUnit(unit: ResourceUnit): ModelDocument | undefined {
  const id = unit.id ? `${unit.id.namespace}:${unit.id.path}` : null;
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
