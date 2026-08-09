import {
  getRsglResourceKindDescriptor,
  type RsglResourceBodyDialect,
  type RsglResourceKind
} from "../resourceKinds";
import type { RsglItemModelBodyOwner } from "../itemModelSyntax";
import type { BlockstateMode } from "./types";

export type BodyParseContext =
  | { kind: "topLevel" }
  | ResourceBodyParseContext
  | BlockstateEntriesParseContext
  | BlockstateRootParseContext
  | BlockstateChoiceParseContext
  | ItemModelBodyParseContext;

export interface BlockstateEntriesParseContext {
  kind: "blockstateEntries";
  mode: BlockstateMode;
}

export interface BlockstateRootParseContext {
  kind: "blockstateRoot";
  mode: BlockstateMode;
  allowBase: boolean;
}

export interface BlockstateChoiceParseContext {
  kind: "blockstateChoice";
}

export interface ItemModelBodyParseContext {
  kind: "itemModelBody";
  owner: RsglItemModelBodyOwner;
}

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

export const topLevelBodyParseContext = Object.freeze({ kind: "topLevel" } satisfies BodyParseContext);
export const variantsBodyParseContext = Object.freeze({
  kind: "blockstateEntries",
  mode: "variants"
} satisfies BlockstateEntriesParseContext);
export const multipartBodyParseContext = Object.freeze({
  kind: "blockstateEntries",
  mode: "multipart"
} satisfies BlockstateEntriesParseContext);
export const choiceBodyParseContext = Object.freeze({
  kind: "blockstateChoice"
} satisfies BlockstateChoiceParseContext);
export const selectItemModelBodyParseContext = Object.freeze({
  kind: "itemModelBody",
  owner: "select"
} satisfies ItemModelBodyParseContext);
export const rangeItemModelBodyParseContext = Object.freeze({
  kind: "itemModelBody",
  owner: "range"
} satisfies ItemModelBodyParseContext);
export const compositeItemModelBodyParseContext = Object.freeze({
  kind: "itemModelBody",
  owner: "composite"
} satisfies ItemModelBodyParseContext);
export const firstMatchItemModelBodyParseContext = Object.freeze({
  kind: "itemModelBody",
  owner: "first_match"
} satisfies ItemModelBodyParseContext);
export const itemModelTemplateBodyParseContext = Object.freeze({
  kind: "itemModelBody",
  owner: "itemModelTemplate"
} satisfies ItemModelBodyParseContext);
export function blockstateRootParseContext<M extends BlockstateMode>(
  mode: M
): BlockstateRootParseContext & { mode: M } {
  return {
    kind: "blockstateRoot",
    mode,
    allowBase: true
  };
}

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

/** Nested transform blocks remain model grammar without inheriting root-only capabilities. */
export const modelTransformBodyParseContext: ResourceBodyParseContext = Object.freeze({
  kind: "resource",
  position: "nonRoot",
  owner: { kind: "section", name: "transform" },
  dialect: "model",
  allowBase: false,
  allowModelExternVariables: false
} satisfies ResourceBodyParseContext);

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
  if (context.kind === "resource") {
    return {
        ...context,
        position: "nonRoot",
        allowBase: false,
        allowModelExternVariables: false
      };
  }
  if (context.kind === "blockstateRoot") {
    return {
      ...context,
      allowBase: false
    };
  }
  return context;
}
