import { resolvedTemplateOutputMetadata } from "../templateOutput";
import { scopeWithLinkedGlobalFallback } from "./linkedScope";
import { lookup } from "./scopes";
import type {
  RsglLegacyBlockstateRootRecord,
  RsglScope,
  RsglTemplateUseRecord
} from "./types";

export interface LegacyBlockstateModeSelection {
  mode?: "variants" | "multipart";
  conflict: boolean;
}

/** Resolves only exact public/legacy producers; contextual adapters stay neutral. */
export function resolveLegacyBlockstateMode(
  record: RsglLegacyBlockstateRootRecord,
  linkedGlobalScope?: RsglScope
): LegacyBlockstateModeSelection {
  const modes = new Set(record.directModes);
  for (const use of record.uses) {
    const mode = concreteTemplateUseMode(use, linkedGlobalScope);
    if (mode) {
      modes.add(mode);
    }
  }
  return {
    mode: modes.size === 1 ? Array.from(modes)[0] : undefined,
    conflict: modes.size > 1
  };
}

export function applyLegacyBlockstateMode(
  record: RsglLegacyBlockstateRootRecord,
  selection: LegacyBlockstateModeSelection
): void {
  const mode = selection.conflict ? "neutral" : selection.mode ?? "neutral";
  for (const use of record.uses) {
    if (use.callerContext?.kind === "blockstateRoot") {
      use.callerContext = { ...use.callerContext, mode };
    }
  }
}

function concreteTemplateUseMode(
  record: RsglTemplateUseRecord,
  linkedGlobalScope?: RsglScope
): "variants" | "multipart" | undefined {
  const expression = record.expression;
  if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
    return undefined;
  }
  const scope = linkedGlobalScope
    ? scopeWithLinkedGlobalFallback(record.scope, linkedGlobalScope)
    : record.scope;
  const symbol = lookup(scope, expression.callee.name.text);
  const metadata = symbol ? resolvedTemplateOutputMetadata(symbol) : undefined;
  if (metadata?.outputSource === "explicitArrow") {
    return metadata.outputDialect === "variants" || metadata.outputDialect === "multipart"
      ? metadata.outputDialect
      : undefined;
  }
  if (metadata?.outputSource !== "legacyInferredBody") {
    return undefined;
  }
  const dialect = metadata.legacyOutputDialect;
  if (dialect.kind !== "blockstateRoot" && dialect.kind !== "blockstateEntries") {
    return undefined;
  }
  return dialect.mode === "neutral" ? undefined : dialect.mode;
}
