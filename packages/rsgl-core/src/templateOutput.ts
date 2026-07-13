import type { TemplateDeclNode, TemplateOutputDialect } from "./parser";
import type { RsglResourceKind } from "./resourceKinds";

export type RsglLegacyTemplateBodyDialect =
  | {
      kind: "resourceBody";
      resourceKind: Exclude<RsglResourceKind, "blockstate">;
    }
  | {
      kind: "blockstateRoot";
      mode: "neutral" | "variants" | "multipart";
      allowRootMerge: true;
      allowBase: false;
    }
  | {
      kind: "blockstateEntries";
      mode: "variants" | "multipart";
      allowRootMerge: false;
      allowBase: false;
    };

export type ResolvedTemplateOutputMetadata =
  | { outputSource: "noArrowResources"; outputDialect: "resources" }
  | {
      outputSource: "explicitArrow";
      outputDialect: Exclude<TemplateOutputDialect, "resources">;
    }
  | {
      outputSource: "legacyInferredBody";
      legacyOutputDialect: RsglLegacyTemplateBodyDialect;
    }
  | {
      outputSource: "legacyContextualAdapter";
      bodyNodeKind: "Block" | "ResourceBody";
    };

/** Separate invalid-definition carrier; intentionally not a metadata union arm. */
export interface ResolvedTemplateOutputConflict {
  evidence: readonly string[];
}

export type RsglTemplateCallerContext =
  | { kind: "resources" }
  | {
      kind: "resourceBody";
      resourceKind: Exclude<RsglResourceKind, "blockstate">;
    }
  | {
      kind: "blockstateRoot";
      mode: "neutral" | "variants" | "multipart";
      allowRootMerge: boolean;
      allowBase: boolean;
    }
  | {
      kind: "blockstateEntries";
      mode: "variants" | "multipart";
      allowRootMerge: false;
      allowBase: false;
    };

export interface TemplateOutputMetadataCarrier {
  node?: unknown;
  outputMetadata?: ResolvedTemplateOutputMetadata;
  signature?: { templateOutput?: ResolvedTemplateOutputMetadata };
}

export interface TemplateOutputDispatch {
  compatible: boolean;
  selectedDialect?:
    | TemplateOutputDialect
    | RsglLegacyTemplateBodyDialect
    | Exclude<RsglTemplateCallerContext, { kind: "resources" }>;
  compatibilityWarning: boolean;
  failure?: "bodyContextRequired" | "dialectMismatch" | "blockstateModeConflict" | "invalidDefinition";
}

/**
 * Reads the frozen semantic/link result. The fallback only covers explicit
 * syntax and is intentionally unable to infer legacy bodies.
 */
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
  if (!isTemplateDeclNode(node)) {
    return undefined;
  }
  if (node.outputSyntax === "explicitArrow" && node.declaredOutputDialect) {
    return { outputSource: "explicitArrow", outputDialect: node.declaredOutputDialect };
  }
  return undefined;
}

function isTemplateDeclNode(node: unknown): node is TemplateDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "TemplateDecl");
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
  const callerMode = concreteBlockstateCallerMode(callerContext);
  const producerMode = concreteBlockstateProducerMode(metadata);
  if (callerMode && producerMode && callerMode !== producerMode) {
    return {
      compatible: false,
      compatibilityWarning: metadata.outputSource === "legacyInferredBody",
      failure: "blockstateModeConflict"
    };
  }
  if (metadata.outputSource === "noArrowResources") {
    return publicDispatch(callerContext.kind === "resources", "resources");
  }
  if (metadata.outputSource === "explicitArrow") {
    return publicDispatch(
      publicDialectMatchesCaller(metadata.outputDialect, callerContext),
      metadata.outputDialect
    );
  }
  if (metadata.outputSource === "legacyInferredBody") {
    return {
      ...publicDispatch(legacyDialectMatchesCaller(metadata.legacyOutputDialect, callerContext), metadata.legacyOutputDialect),
      compatibilityWarning: true
    };
  }
  if (
    callerContext.kind === "resources"
    || callerContext.kind === "blockstateEntries"
    || (callerContext.kind === "blockstateRoot" && callerContext.mode === "neutral")
  ) {
    return {
      compatible: false,
      compatibilityWarning: true,
      failure: "bodyContextRequired"
    };
  }
  return {
    compatible: true,
    selectedDialect: callerContext,
    compatibilityWarning: true
  };
}

function concreteBlockstateCallerMode(
  callerContext: RsglTemplateCallerContext
): "variants" | "multipart" | undefined {
  if (callerContext.kind !== "blockstateRoot" && callerContext.kind !== "blockstateEntries") {
    return undefined;
  }
  return callerContext.mode === "neutral" ? undefined : callerContext.mode;
}

function concreteBlockstateProducerMode(
  metadata: ResolvedTemplateOutputMetadata
): "variants" | "multipart" | undefined {
  if (metadata.outputSource === "explicitArrow") {
    return metadata.outputDialect === "variants" || metadata.outputDialect === "multipart"
      ? metadata.outputDialect
      : undefined;
  }
  if (metadata.outputSource !== "legacyInferredBody") {
    return undefined;
  }
  const dialect = metadata.legacyOutputDialect;
  if (dialect.kind !== "blockstateRoot" && dialect.kind !== "blockstateEntries") {
    return undefined;
  }
  return dialect.mode === "neutral" ? undefined : dialect.mode;
}

/**
 * Returns the body context fixed by a template definition. Contextual legacy
 * adapters intentionally return undefined because their context is selected
 * only by a concrete use site.
 */
export function templateOutputBodyCallerContext(
  metadata: ResolvedTemplateOutputMetadata
): RsglTemplateCallerContext | undefined {
  if (metadata.outputSource === "noArrowResources") {
    return { kind: "resources" };
  }
  if (metadata.outputSource === "explicitArrow") {
    if (metadata.outputDialect === "model") {
      return { kind: "resourceBody", resourceKind: "model" };
    }
    return {
      kind: "blockstateEntries",
      mode: metadata.outputDialect,
      allowRootMerge: false,
      allowBase: false
    };
  }
  if (metadata.outputSource === "legacyContextualAdapter") {
    return undefined;
  }
  return { ...metadata.legacyOutputDialect };
}

export function normalizeTemplateCallerContext(context: RsglTemplateCallerContext): string {
  if (context.kind === "resources") {
    return "resources";
  }
  if (context.kind === "resourceBody") {
    return `resourceBody:${context.resourceKind}`;
  }
  return [
    context.kind,
    context.mode,
    context.allowRootMerge ? "rootMerge" : "noRootMerge",
    context.allowBase ? "base" : "noBase"
  ].join(":");
}

export function templateOutputMetadataFingerprint(metadata: ResolvedTemplateOutputMetadata): string {
  if (metadata.outputSource === "noArrowResources") {
    return "noArrowResources:resources";
  }
  if (metadata.outputSource === "explicitArrow") {
    return `explicitArrow:${metadata.outputDialect}`;
  }
  if (metadata.outputSource === "legacyContextualAdapter") {
    return `legacyContextualAdapter:${metadata.bodyNodeKind}`;
  }
  const dialect = metadata.legacyOutputDialect;
  if (dialect.kind === "resourceBody") {
    return `legacyInferredBody:resourceBody:${dialect.resourceKind}`;
  }
  return [
    "legacyInferredBody",
    dialect.kind,
    dialect.mode,
    dialect.allowRootMerge ? "rootMerge" : "noRootMerge",
    dialect.allowBase ? "base" : "noBase"
  ].join(":");
}

export function formatTemplateOutputMetadata(metadata: ResolvedTemplateOutputMetadata): string {
  if (metadata.outputSource === "noArrowResources") {
    return "template resources";
  }
  if (metadata.outputSource === "explicitArrow") {
    return `template -> ${metadata.outputDialect}`;
  }
  if (metadata.outputSource === "legacyContextualAdapter") {
    return `legacy contextual template (${metadata.bodyNodeKind})`;
  }
  const dialect = metadata.legacyOutputDialect;
  return dialect.kind === "resourceBody"
    ? `legacy template body (${dialect.resourceKind})`
    : `legacy ${dialect.kind} template (${dialect.mode})`;
}

function publicDispatch(
  compatible: boolean,
  selectedDialect: TemplateOutputDispatch["selectedDialect"]
): TemplateOutputDispatch {
  return compatible
    ? { compatible: true, selectedDialect, compatibilityWarning: false }
    : { compatible: false, compatibilityWarning: false, failure: "dialectMismatch" };
}

function publicDialectMatchesCaller(
  dialect: Exclude<TemplateOutputDialect, "resources">,
  callerContext: RsglTemplateCallerContext
): boolean {
  if (dialect === "model") {
    return callerContext.kind === "resourceBody" && callerContext.resourceKind === "model";
  }
  if (callerContext.kind === "blockstateEntries") {
    return callerContext.mode === dialect;
  }
  return callerContext.kind === "blockstateRoot"
    && (callerContext.mode === "neutral" || callerContext.mode === dialect);
}

function legacyDialectMatchesCaller(
  dialect: RsglLegacyTemplateBodyDialect,
  callerContext: RsglTemplateCallerContext
): boolean {
  if (dialect.kind === "resourceBody") {
    return callerContext.kind === "resourceBody" && callerContext.resourceKind === dialect.resourceKind;
  }
  if (dialect.kind === "blockstateEntries") {
    if (callerContext.kind === "blockstateEntries") {
      return callerContext.mode === dialect.mode;
    }
    return callerContext.kind === "blockstateRoot"
      && (callerContext.mode === "neutral" || callerContext.mode === dialect.mode);
  }
  if (callerContext.kind !== "blockstateRoot" || !callerContext.allowRootMerge) {
    return false;
  }
  if (dialect.mode === "neutral") {
    return callerContext.mode !== "neutral";
  }
  return callerContext.mode === "neutral" || callerContext.mode === dialect.mode;
}
