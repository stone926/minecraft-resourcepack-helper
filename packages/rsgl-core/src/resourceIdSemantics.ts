export type RsglResourceValueKind = "generic" | "model" | "texture";

export const rsglResourceIdConstructors = {
  resource_id: "generic",
  model_id: "model",
  texture_id: "texture"
} as const satisfies Record<string, RsglResourceValueKind>;

export type RsglResourceIdConstructorName = keyof typeof rsglResourceIdConstructors;

export function isRsglResourceIdConstructorName(
  name: string
): name is RsglResourceIdConstructorName {
  return Object.hasOwn(rsglResourceIdConstructors, name);
}

export function resourceValueKindForTypeKind(
  typeKind: string
): RsglResourceValueKind | undefined {
  if (typeKind === "ResourceId") {
    return "generic";
  }
  if (typeKind === "ModelId") {
    return "model";
  }
  if (typeKind === "TextureId") {
    return "texture";
  }
  return undefined;
}

export function typeKindForResourceValueKind(
  resourceKind: RsglResourceValueKind
): "ResourceId" | "ModelId" | "TextureId" {
  if (resourceKind === "model") {
    return "ModelId";
  }
  if (resourceKind === "texture") {
    return "TextureId";
  }
  return "ResourceId";
}

export function isResourceValueKindAssignable(
  expected: RsglResourceValueKind,
  actual: RsglResourceValueKind
): boolean {
  return expected === "generic" || expected === actual;
}
