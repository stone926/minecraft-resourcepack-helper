import * as path from "node:path";
import { getAssetResource, isModelDocumentPath } from "../utils/resourceGraphSearch";
import type { ResourceReference } from "../utils/resourceReferences/types";
import { classifyResourceGraphPreview } from "./resourceGraphPreviewClassifier";
import { generatedResourceContext } from "./resourceGraphGeneratedPresentation";
import type {
  ResourceGraphLocalize,
  ResourceGraphProjectedResource,
  ResourceGraphTreeResolvedReference,
  ResourceGraphUriLike
} from "./resourceGraphTreeTypes";

export function getReferenceLabel(reference: ResourceReference, localize: ResourceGraphLocalize): string {
  switch (reference.kind) {
    case "model": return localize("model: {0}", reference.value);
    case "texture": return localize("texture: {0}", reference.value);
    case "textureDirectory": return localize("texture directory: {0}", reference.value);
    case "font": return localize("font: {0}", reference.value);
    case "fontFile": return localize("font file: {0}", reference.value);
    case "shader": return localize("shader: {0}", reference.value);
    default: return localize("sound: {0}", reference.value);
  }
}

export function referenceDescription(
  reference: ResourceGraphTreeResolvedReference,
  localize: ResourceGraphLocalize
): string {
  const label = getReferenceLabel(reference.reference, localize);
  return reference.sourceRange
    ? `${label} · ${reference.sourceRange.start}–${reference.sourceRange.end}`
    : label;
}

export function getReferenceIcon(reference: ResourceReference): string {
  if (reference.kind === "textureDirectory") {
    return "folder";
  }
  if (["model", "shader", "font", "fontFile"].includes(reference.kind)) {
    return "file-code";
  }
  return "file-media";
}

export function getResourceIcon(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".json") {
    return isModelDocumentPath(fileName) ? "file-code" : "json";
  }
  if (extension === ".png" || extension === ".ogg") {
    return "file-media";
  }
  if (extension === ".vsh" || extension === ".fsh" || extension === ".glsl") {
    return "file-code";
  }
  return extension ? "file" : "folder";
}

export function getGeneratedResourceIcon(kind: string): string {
  if (kind === "model" || kind === "blockstate" || kind === "item" || kind === "font") {
    return "file-code";
  }
  if (kind === "texture" || kind === "sound") {
    return "file-media";
  }
  return "symbol-object";
}

export function getFocusedResourceContext(
  resource: ResourceGraphProjectedResource,
  resourceUri: ResourceGraphUriLike | undefined
): string | undefined {
  if (resource.producer.origin === "generated") {
    return generatedResourceContext(resource);
  }
  if (resource.resolutionStatus === "conflict") {
    return resource.target.kind === "model" && resourceUri
      ? "resourceGraphFocusedModelConflict"
      : "resourceGraphFocusedResourceConflict";
  }
  return resourceUri
    ? classifyResourceGraphPreview(resourceUri.fsPath)
    : undefined;
}

export function getResourcePathLabel(uri: ResourceGraphUriLike): string {
  const resource = getAssetResource(uri.fsPath);
  return resource ? `${resource.namespace}:${resource.resourcePath}` : path.basename(uri.fsPath);
}
