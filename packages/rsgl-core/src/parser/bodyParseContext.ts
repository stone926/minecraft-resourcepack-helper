import {
  getRsglResourceKindDescriptor,
  type RsglResourceBodyDialect,
  type RsglResourceKind
} from "../resourceKinds";

export type BodyParseContext =
  | { kind: "topLevel" }
  | ResourceBodyParseContext
  | { kind: "variants" }
  | { kind: "multipart" };

export type ResourceBodyOwner =
  | { kind: "resourceRoot"; resourceKind: RsglResourceKind }
  | { kind: "template" }
  | { kind: "section"; name: string }
  | { kind: "domainBody"; name: "packOverlay" | "atlasPalettedPermutations" };

export type ResourceBodyParseContext =
  | {
      kind: "resource";
      position: "concreteResourceRoot";
      owner: Extract<ResourceBodyOwner, { kind: "resourceRoot" }>;
      dialect: RsglResourceBodyDialect;
      allowBase: true;
      allowModelExternVariables: boolean;
    }
  | {
      kind: "resource";
      position: "nonRoot";
      /** Semantic owner used by owner-specific resource-body sugar. */
      owner: ResourceBodyOwner;
      /** Grammar selected once at the body boundary and copied through control flow. */
      dialect: RsglResourceBodyDialect;
      allowBase: false;
      allowModelExternVariables: false;
    };

export const topLevelBodyParseContext: BodyParseContext = Object.freeze({ kind: "topLevel" });
export const variantsBodyParseContext: BodyParseContext = Object.freeze({ kind: "variants" });
export const multipartBodyParseContext: BodyParseContext = Object.freeze({ kind: "multipart" });

export function concreteResourceBodyParseContext(resourceKind: RsglResourceKind): ResourceBodyParseContext {
  const descriptor = getRsglResourceKindDescriptor(resourceKind);
  return {
    kind: "resource",
    position: "concreteResourceRoot",
    owner: { kind: "resourceRoot", resourceKind },
    dialect: descriptor?.ast.bodyDialect ?? "generic",
    allowBase: true,
    allowModelExternVariables: descriptor?.ast.bodyDialect === "model"
  };
}

export function sectionResourceBodyParseContext(name: string): ResourceBodyParseContext {
  return {
    kind: "resource",
    position: "nonRoot",
    owner: { kind: "section", name },
    dialect: "generic",
    allowBase: false,
    allowModelExternVariables: false
  };
}

export function domainResourceBodyParseContext(
  name: Extract<ResourceBodyOwner, { kind: "domainBody" }>["name"]
): ResourceBodyParseContext {
  return {
    kind: "resource",
    position: "nonRoot",
    owner: { kind: "domainBody", name },
    dialect: "generic",
    allowBase: false,
    allowModelExternVariables: false
  };
}

export function templateResourceBodyParseContext(
  dialect: RsglResourceBodyDialect = "generic"
): ResourceBodyParseContext {
  return {
    kind: "resource",
    position: "nonRoot",
    owner: { kind: "template" },
    dialect,
    allowBase: false,
    allowModelExternVariables: false
  };
}

export function resourceBodyOwnerName(owner: ResourceBodyOwner): string {
  if (owner.kind === "resourceRoot") {
    return owner.resourceKind;
  }
  return owner.kind === "template" ? "template" : owner.name;
}

/** Control-flow bodies retain their grammar while losing root-only capabilities. */
export function nestedControlFlowBodyParseContext(context: BodyParseContext): BodyParseContext {
  return context.kind === "resource"
    ? {
        ...context,
        position: "nonRoot",
        allowBase: false,
        allowModelExternVariables: false
      }
    : context;
}
