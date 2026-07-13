import {
  jsonType,
  modelIdType,
  resourceIdType,
  textureIdType,
  textureRefType,
  type RsglType
} from "./types";

/** Semantic expected types shared by schema-known resource-reference sinks. */
export const rsglResourceReferenceSinkTypes = {
  resource: resourceIdType,
  model: modelIdType,
  itemModel: {
    kind: "Union",
    options: [
      modelIdType,
      { kind: "Object", open: true, indexType: jsonType },
      { kind: "Json", contextualEscapeOnly: true }
    ]
  },
  texture: textureIdType,
  modelTexture: textureRefType,
  textureList: { kind: "List", elementType: textureIdType }
} as const satisfies Record<string, RsglType>;

export type RsglResourceReferenceSinkType = keyof typeof rsglResourceReferenceSinkTypes;

export function expectedTypeForResourceReferenceSink(
  sink: RsglResourceReferenceSinkType
): RsglType {
  return rsglResourceReferenceSinkTypes[sink];
}

/**
 * Resolves the reference contracts represented by generic PropertyStmt nodes.
 * Dedicated AST nodes select their contract directly in the body checker.
 */
export function resourcePropertyReferenceSink(
  resourceKind: string | undefined,
  owner: string,
  property: string
): RsglResourceReferenceSinkType | undefined {
  const rootOwner = owner === "resource" || owner === resourceKind;
  if (resourceKind === "model") {
    if (rootOwner && property === "parent") {
      return "model";
    }
    if (owner === "textures") {
      return "modelTexture";
    }
  }
  if (resourceKind === "item" && rootOwner && property === "model") {
    return "itemModel";
  }
  if (resourceKind === "particles" && rootOwner && property === "textures") {
    return "textureList";
  }
  return undefined;
}
