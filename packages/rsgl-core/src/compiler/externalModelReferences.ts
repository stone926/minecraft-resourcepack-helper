import type { ExternResourceSource } from "../externDeclarations";
import type { JsonValue } from "./ir";
import type { RsglResourceReferenceConsumer } from "./resourceReferenceConsumers";
import { asObject } from "./validationPrimitives";

export interface RsglExternalModelDocument {
  id: string;
  namespace: string;
  content: Record<string, JsonValue>;
  externalSource: ExternResourceSource;
}

export interface RsglExternalModelReferenceVisitor {
  resource(
    document: RsglExternalModelDocument,
    consumer: RsglResourceReferenceConsumer,
    rawValue: string
  ): void;
  textureVariable(document: RsglExternalModelDocument, name: string): void;
}

/** Visits schema-known references in loaded external model content. */
export function visitExternalModelReferences(
  documents: Iterable<RsglExternalModelDocument>,
  visitor: RsglExternalModelReferenceVisitor
): void {
  for (const document of documents) {
    visitTextureSlots(document, visitor);
    visitFaceTextures(document, visitor);
    visitLegacyOverrides(document, visitor);
  }
}

function visitTextureSlots(
  document: RsglExternalModelDocument,
  visitor: RsglExternalModelReferenceVisitor
): void {
  for (const value of Object.values(asObject(document.content.textures) ?? {})) {
    if (typeof value === "string") {
      visitTextureValue(document, value, visitor);
      continue;
    }
    const sprite = asObject(value)?.sprite;
    if (typeof sprite === "string") {
      visitTextureValue(document, sprite, visitor);
    }
  }
}

function visitFaceTextures(
  document: RsglExternalModelDocument,
  visitor: RsglExternalModelReferenceVisitor
): void {
  const elements = Array.isArray(document.content.elements) ? document.content.elements : [];
  for (const elementValue of elements) {
    for (const faceValue of Object.values(asObject(asObject(elementValue)?.faces) ?? {})) {
      const texture = asObject(faceValue)?.texture;
      if (typeof texture === "string") {
        visitTextureValue(document, texture, visitor);
      }
    }
  }
}

function visitLegacyOverrides(
  document: RsglExternalModelDocument,
  visitor: RsglExternalModelReferenceVisitor
): void {
  const overrides = Array.isArray(document.content.overrides) ? document.content.overrides : [];
  for (const value of overrides) {
    const model = asObject(value)?.model;
    if (typeof model === "string") {
      visitor.resource(document, "model", model);
    }
  }
}

function visitTextureValue(
  document: RsglExternalModelDocument,
  value: string,
  visitor: RsglExternalModelReferenceVisitor
): void {
  if (value.startsWith("#") && value.length > 1) {
    visitor.textureVariable(document, value.slice(1));
  } else {
    visitor.resource(document, "modelTexture", value);
  }
}
