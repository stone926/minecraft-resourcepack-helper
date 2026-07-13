import {
  normalizeTemplateCallerContext,
  resolvedTemplateOutputMetadata,
  resolveTemplateOutputDispatch,
  type RsglTemplateCallerContext,
  type TemplateOutputDispatch
} from "../templateOutput";
import type { RsglTemplateDefinition } from "./environment";

/** Bounded cache for immutable dispatch choices; evaluated expansions are never stored. */
export class RsglTemplateDispatchCache {
  private readonly entries = new Map<string, TemplateOutputDispatch>();

  public constructor(private readonly maxEntries = 256) { }

  public resolve(
    definition: RsglTemplateDefinition,
    callerContext: RsglTemplateCallerContext
  ): TemplateOutputDispatch {
    if (definition.outputConflict) {
      return invalidDefinitionDispatch;
    }
    const metadata = resolvedTemplateOutputMetadata(definition);
    if (!metadata) {
      throw new Error(`Template '${definition.name}' has no resolved output metadata.`);
    }
    const bodyNodeKind = metadata.outputSource === "legacyContextualAdapter"
      ? metadata.bodyNodeKind
      : definition.node.body.kind;
    const key = [
      definition.definitionFingerprint,
      bodyNodeKind,
      normalizeTemplateCallerContext(callerContext)
    ].join("\0");
    const cached = this.entries.get(key);
    if (cached) {
      // Refresh insertion order for a small LRU without retaining expansion data.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const dispatch = resolveTemplateOutputDispatch(callerContext, metadata);
    this.entries.set(key, dispatch);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    return dispatch;
  }

  public get size(): number {
    return this.entries.size;
  }
}

const invalidDefinitionDispatch: TemplateOutputDispatch = Object.freeze({
  compatible: false,
  compatibilityWarning: false,
  failure: "invalidDefinition"
});
