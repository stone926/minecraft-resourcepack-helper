import {
  minecraftResourceIdInFolder,
  minecraftResourceIdToString,
  tryParseMinecraftResourceId
} from "../../../mc-assets/src";
import type { RsglResourceExistenceKind } from "./validationTypes";
import type { RsglResourceValueKind } from "../resourceIdSemantics";

export interface RsglResourceReferenceConsumerContext {
  equipmentLayer?: string;
}

interface RsglResourceReferenceConsumerDescriptor {
  targetKind: RsglResourceExistenceKind;
  allowTextureVariable?: boolean;
  resourcePathPlaceholder?: string;
  /** The RSGL shorthand must be expanded in emitted JSON as well as lookup. */
  emitLookupId?: boolean;
  normalizeLookup?: (
    rawValue: string,
    defaultNamespace: string,
    context: RsglResourceReferenceConsumerContext
  ) => string | null;
}

const directReference = (targetKind: RsglResourceExistenceKind): RsglResourceReferenceConsumerDescriptor => ({
  targetKind
});

/**
 * Central contracts for every resource-reference sink understood by RSGL.
 * Unknown Json/String fields deliberately do not appear here and therefore
 * retain their source text.
 */
export const resourceReferenceConsumers = {
  model: directReference("model"),
  blockstate: directReference("blockstate"),
  item: directReference("item"),
  texture: directReference("texture"),
  modelTexture: { ...directReference("texture"), allowTextureVariable: true },
  textureDirectory: directReference("textureDirectory"),
  sound: directReference("sound"),
  font: directReference("font"),
  fontFile: directReference("fontFile"),
  fontLegacyUnicodeTemplate: {
    ...directReference("texture"),
    resourcePathPlaceholder: "%s"
  },
  shaderVertex: directReference("shaderVertex"),
  shaderFragment: directReference("shaderFragment"),
  particleTexture: {
    ...directReference("texture"),
    emitLookupId: true,
    normalizeLookup: (value, namespace) => minecraftResourceIdInFolder(value, namespace, "particle")
  },
  equipmentTexture: {
    ...directReference("texture"),
    normalizeLookup: (value, namespace, context) => context.equipmentLayer
      ? minecraftResourceIdInFolder(value, namespace, `entity/equipment/${context.equipmentLayer}`)
      : null
  },
  postEffectTexture: {
    ...directReference("texture"),
    normalizeLookup: (value, namespace) => minecraftResourceIdInFolder(value, namespace, "effect")
  },
  waypointSpriteTexture: {
    ...directReference("texture"),
    normalizeLookup: (value, namespace) => minecraftResourceIdInFolder(
      value,
      namespace,
      "gui/sprites/hud/locator_bar_dot"
    )
  },
  itemSpecialChestTexture: {
    ...directReference("texture"),
    normalizeLookup: (value, namespace) => minecraftResourceIdInFolder(value, namespace, "entity/chest")
  },
  itemSpecialShulkerTexture: {
    ...directReference("texture"),
    normalizeLookup: (value, namespace) => minecraftResourceIdInFolder(value, namespace, "entity/shulker")
  },
  itemSpecialHeadTexture: {
    ...directReference("texture"),
    normalizeLookup: (value, namespace) => minecraftResourceIdInFolder(value, namespace, "entity")
  },
  itemSpecialCopperGolemTexture: {
    ...directReference("texture"),
    normalizeLookup: (value, namespace) => {
      const id = tryParseMinecraftResourceId(value, namespace);
      return id
        ? minecraftResourceIdToString({
          namespace: id.namespace,
          path: id.path.replace(/^textures\//, "").replace(/\.png$/, "")
        })
        : null;
    }
  }
} as const satisfies Record<string, RsglResourceReferenceConsumerDescriptor>;

export type RsglResourceReferenceConsumer = keyof typeof resourceReferenceConsumers;

/** Typed runtime kind required by a schema-known consumer. */
export function resourceValueKindForConsumer(
  consumer: RsglResourceReferenceConsumer
): RsglResourceValueKind {
  const targetKind = resourceReferenceConsumers[consumer].targetKind;
  if (targetKind === "model") {
    return "model";
  }
  if (targetKind === "texture" || targetKind === "textureDirectory") {
    return "texture";
  }
  return "generic";
}

export function resourceConsumerAllowsTextureVariable(
  consumer: RsglResourceReferenceConsumer
): boolean {
  return resourceReferenceConsumers[consumer].allowTextureVariable === true;
}

const itemSpecialTextureConsumers = {
  chest: "itemSpecialChestTexture",
  shulker_box: "itemSpecialShulkerTexture",
  head: "itemSpecialHeadTexture",
  copper_golem_statue: "itemSpecialCopperGolemTexture"
} as const satisfies Record<string, RsglResourceReferenceConsumer>;

export function getItemSpecialTextureConsumer(type: string | null): RsglResourceReferenceConsumer | null {
  return type && Object.hasOwn(itemSpecialTextureConsumers, type)
    ? itemSpecialTextureConsumers[type as keyof typeof itemSpecialTextureConsumers]
    : null;
}

export type RsglCanonicalResourceReference =
  | {
    kind: "resource";
    targetKind: RsglResourceExistenceKind;
    /** Canonical value written to the Minecraft JSON field. */
    id: string;
    /** Canonical physical resource target used for resolution. */
    lookupId: string;
  }
  | {
    kind: "textureVariable";
    targetKind: "texture";
    value: string;
  }
  | {
    kind: "invalid";
    targetKind: RsglResourceExistenceKind;
  };

export function canonicalizeResourceReference(
  consumer: RsglResourceReferenceConsumer,
  rawValue: string,
  defaultNamespace: string,
  context: RsglResourceReferenceConsumerContext = {}
): RsglCanonicalResourceReference {
  const descriptor = resourceReferenceConsumers[consumer];
  if (descriptor.allowTextureVariable && rawValue.startsWith("#")) {
    return rawValue.length > 1
      ? { kind: "textureVariable", targetKind: "texture", value: rawValue }
      : { kind: "invalid", targetKind: descriptor.targetKind };
  }

  const emittedId = canonicalizeDirectReference(
    rawValue,
    defaultNamespace,
    descriptor.resourcePathPlaceholder
  );
  const normalizedLookup = descriptor.normalizeLookup
    ? descriptor.normalizeLookup(rawValue, defaultNamespace, context)
    : emittedId;
  const lookupId = descriptor.resourcePathPlaceholder
    ? null
    : normalizedLookup
      ? tryParseMinecraftResourceId(normalizedLookup, defaultNamespace)
      : null;
  const canonicalLookupId = descriptor.resourcePathPlaceholder
    ? emittedId
    : lookupId
      ? minecraftResourceIdToString(lookupId)
      : null;
  return emittedId && canonicalLookupId
    ? {
      kind: "resource",
      targetKind: descriptor.targetKind,
      id: descriptor.emitLookupId ? canonicalLookupId : emittedId,
      lookupId: canonicalLookupId
    }
    : { kind: "invalid", targetKind: descriptor.targetKind };
}

function canonicalizeDirectReference(
  rawValue: string,
  defaultNamespace: string,
  resourcePathPlaceholder?: string
): string | null {
  if (!resourcePathPlaceholder) {
    const id = tryParseMinecraftResourceId(rawValue, defaultNamespace);
    return id ? minecraftResourceIdToString(id) : null;
  }

  if (rawValue.split(resourcePathPlaceholder).length !== 2) {
    return null;
  }
  const marker = "__rsgl_resource_path_placeholder__";
  const id = tryParseMinecraftResourceId(rawValue.replace(resourcePathPlaceholder, marker), defaultNamespace);
  if (!id || !id.path.includes(marker)) {
    return null;
  }
  return minecraftResourceIdToString(id).replace(marker, resourcePathPlaceholder);
}
