import type { TemplateDeclNode, TemplateOutputDialect } from "./parser";
import type { RsglResourceKind } from "./resourceKinds";

export type ResolvedTemplateOutputMetadata =
  | { outputSource: "noArrowResources"; outputDialect: "resources" }
  | {
      outputSource: "explicitArrow";
      outputDialect: Exclude<TemplateOutputDialect, "resources" | "item_model">;
    }
  | {
      outputSource: "explicitArrow";
      outputDialect: "item_model";
      cardinality: "one";
    };

export type RsglTemplateCallerContext =
  | { kind: "resources" }
  | {
      kind: "resourceBody";
      resourceKind: Exclude<RsglResourceKind, "blockstate">;
    }
  | {
      kind: "blockstateRoot";
      mode: "variants" | "multipart";
      allowRootMerge: boolean;
      allowBase: boolean;
    }
  | {
      kind: "blockstateEntries";
      mode: "variants" | "multipart";
      allowRootMerge: false;
      allowBase: false;
    }
  | { kind: "blockstateChoice" }
  | { kind: "itemModel" };

export interface TemplateOutputMetadataCarrier {
  node?: unknown;
  outputMetadata?: ResolvedTemplateOutputMetadata;
  signature?: { templateOutput?: ResolvedTemplateOutputMetadata };
}

export interface TemplateOutputDispatch {
  compatible: boolean;
  selectedDialect?: TemplateOutputDialect;
  failure?: "dialectMismatch";
}

/** Returns the output contract expressed directly by a template declaration. */
export function templateOutputMetadataForDeclaration(
  template: TemplateDeclNode
): ResolvedTemplateOutputMetadata {
  if (template.outputSyntax === "explicitArrow" && template.declaredOutputDialect) {
    return template.declaredOutputDialect === "item_model" ? {
      outputSource: "explicitArrow",
      outputDialect: "item_model",
      cardinality: "one"
    } : {
      outputSource: "explicitArrow",
      outputDialect: template.declaredOutputDialect
    };
  }
  return { outputSource: "noArrowResources", outputDialect: "resources" };
}

export function resolvedTemplateOutputMetadata(
  template: TemplateOutputMetadataCarrier | TemplateDeclNode
): ResolvedTemplateOutputMetadata | undefined {
  if ("signature" in template && template.signature?.templateOutput) {
    return template.signature.templateOutput;
  }
  if ("outputMetadata" in template && template.outputMetadata) {
    return template.outputMetadata;
  }
  const node = "node" in template ? template.node : template;
  return isTemplateDeclNode(node)
    ? templateOutputMetadataForDeclaration(node)
    : undefined;
}

export function isTemplateOutputCompatible(
  callerContext: RsglTemplateCallerContext,
  metadata: ResolvedTemplateOutputMetadata
): boolean {
  return resolveTemplateOutputDispatch(callerContext, metadata).compatible;
}

export function resolveTemplateOutputDispatch(
  callerContext: RsglTemplateCallerContext,
  metadata: ResolvedTemplateOutputMetadata
): TemplateOutputDispatch {
  if (metadata.outputSource === "noArrowResources") {
    return publicDispatch(callerContext.kind === "resources", "resources");
  }
  return publicDispatch(
    publicDialectMatchesCaller(metadata.outputDialect, callerContext),
    metadata.outputDialect
  );
}

export function templateOutputBodyCallerContext(
  metadata: ResolvedTemplateOutputMetadata
): RsglTemplateCallerContext {
  if (metadata.outputSource === "noArrowResources") {
    return { kind: "resources" };
  }
  if (metadata.outputDialect === "model") {
    return { kind: "resourceBody", resourceKind: "model" };
  }
  if (metadata.outputDialect === "choice") {
    return { kind: "blockstateChoice" };
  }
  if (metadata.outputDialect === "item_model") {
    return { kind: "itemModel" };
  }
  return {
    kind: "blockstateEntries",
    mode: metadata.outputDialect,
    allowRootMerge: false,
    allowBase: false
  };
}

export function normalizeTemplateCallerContext(context: RsglTemplateCallerContext): string {
  if (context.kind === "resources") {
    return "resources";
  }
  if (context.kind === "resourceBody") {
    return `resourceBody:${context.resourceKind}`;
  }
  if (context.kind === "blockstateChoice") {
    return "blockstateChoice";
  }
  if (context.kind === "itemModel") {
    return "itemModel";
  }
  return [
    context.kind,
    context.mode,
    context.allowRootMerge ? "rootMerge" : "noRootMerge",
    context.allowBase ? "base" : "noBase"
  ].join(":");
}

export function templateOutputMetadataFingerprint(metadata: ResolvedTemplateOutputMetadata): string {
  return `${metadata.outputSource}:${metadata.outputDialect}${
    metadata.outputDialect === "item_model" ? `:${metadata.cardinality}` : ""
  }`;
}

export function formatTemplateOutputMetadata(metadata: ResolvedTemplateOutputMetadata): string {
  return metadata.outputSource === "noArrowResources"
    ? "template resources"
    : `template -> ${metadata.outputDialect}`;
}

function publicDispatch(
  compatible: boolean,
  selectedDialect: TemplateOutputDialect
): TemplateOutputDispatch {
  return compatible
    ? { compatible: true, selectedDialect }
    : { compatible: false, failure: "dialectMismatch" };
}

function publicDialectMatchesCaller(
  dialect: Exclude<TemplateOutputDialect, "resources">,
  callerContext: RsglTemplateCallerContext
): boolean {
  if (dialect === "model") {
    return callerContext.kind === "resourceBody" && callerContext.resourceKind === "model";
  }
  if (dialect === "choice") {
    return callerContext.kind === "blockstateChoice";
  }
  if (dialect === "item_model") {
    return callerContext.kind === "itemModel";
  }
  return (callerContext.kind === "blockstateEntries" || callerContext.kind === "blockstateRoot")
    && callerContext.mode === dialect;
}

function isTemplateDeclNode(node: unknown): node is TemplateDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "TemplateDecl");
}
