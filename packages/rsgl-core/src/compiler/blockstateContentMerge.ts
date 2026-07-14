import {
  blockstateMultipartPath,
  blockstateVariantPath
} from "./compilerHelpers";
import {
  blockstateFragmentMergePolicy,
  fragmentMergeEngine,
  mappingTargetsAppliedContent,
  offsetFragmentMappingPath,
  type FragmentMergeMode,
  type MergeResult
} from "./fragmentMerge";
import type { JsonValue, RsglMapping } from "./ir";
import { cloneJsonObject, cloneJsonValue, isJsonObject } from "./jsonValues";
import {
  type BlockstateMode,
  preflightBlockstateRootOperand
} from "./blockstateModePolicy";
import { appendGeneratedPath, joinGeneratedPath } from "./sourcePaths";
import type { RsglCompileContext } from "./templateExpansion";

export type BlockstateSourceRange = { start: number; end: number };

export interface BlockstateBodyContent {
  content: Record<string, JsonValue>;
  mappings: RsglMapping[];
}

export type BlockstateVariantWriter = "base" | "merge" | "direct";

/** Mutable content owned by one concrete, mode-selected blockstate root. */
export interface BlockstateRootState extends BlockstateBodyContent {
  readonly mode: BlockstateMode;
  /** Latest writer for canonical variants keys; used to classify direct conflicts. */
  readonly variantWriters: Map<string, BlockstateVariantWriter>;
}

export interface BlockstateRootFinalizeOrigin {
  sourceRange: BlockstateSourceRange;
  context: RsglCompileContext;
}

export interface BlockstateContentMergeHost {
  onError: (code: string, message: string, range: BlockstateSourceRange, fileName?: string) => void;
  sourceMapping: (
    generatedPath: string,
    sourceRange: BlockstateSourceRange,
    context: RsglCompileContext
  ) => RsglMapping;
}

export function createBlockstateRootState(mode: BlockstateMode): BlockstateRootState {
  return {
    mode,
    content: {},
    mappings: [],
    variantWriters: new Map()
  };
}

/**
 * Owns the ordered mutations of one concrete blockstate root. Control-flow and
 * template executors must share this state rather than compile child fragments
 * in isolation.
 */
export class BlockstateRootMerger {
  private readonly contentMerger: BlockstateContentMerger;

  public constructor(private readonly host: BlockstateContentMergeHost) {
    this.contentMerger = new BlockstateContentMerger(host);
  }

  public createState(mode: BlockstateMode): BlockstateRootState {
    return createBlockstateRootState(mode);
  }

  /** Initializes the complete root from a base document after mode preflight. */
  public initializeBase(
    state: BlockstateRootState,
    content: Record<string, JsonValue>,
    sourceRange: BlockstateSourceRange,
    mappings: readonly RsglMapping[] = []
  ): boolean {
    if (!this.preflight(state, content, sourceRange)) {
      return false;
    }

    state.content = cloneJsonObject(content);
    state.mappings.length = 0;
    state.mappings.push(...mappings);
    this.resetVariantWriters(state, "base");
    return true;
  }

  /** Applies one complete root operand with its original user-visible mode. */
  public mergeRoot(
    state: BlockstateRootState,
    content: Record<string, JsonValue>,
    mode: FragmentMergeMode,
    sourceRange: BlockstateSourceRange,
    context: RsglCompileContext,
    mappings?: readonly RsglMapping[]
  ): MergeResult | undefined {
    if (!this.preflight(state, content, sourceRange)) {
      return undefined;
    }

    const mergeResult = this.contentMerger.apply(
      state,
      content,
      mode,
      sourceRange,
      context,
      mappings
    );
    this.recordMergeVariantWriters(state, mergeResult);
    return mergeResult;
  }

  /** Inserts one canonical variants entry. Direct collisions never overwrite. */
  public insertVariant(
    state: BlockstateRootState,
    key: string,
    value: JsonValue,
    sourceRange: BlockstateSourceRange,
    context: RsglCompileContext,
    mappings?: readonly RsglMapping[]
  ): boolean {
    if (state.mode !== "variants") {
      this.host.onError(
        "rsgl.blockstateModeConflict",
        "A 'multipart' blockstate root cannot receive a variants entry.",
        sourceRange
      );
      return false;
    }

    let variants = state.content.variants;
    if (variants === undefined) {
      variants = {};
      state.content.variants = variants;
    }
    if (!isJsonObject(variants)) {
      this.host.onError(
        "rsgl.invalidBlockstateVariantsRoot",
        "Blockstate 'variants' must be an object before a direct entry can be inserted.",
        sourceRange
      );
      return false;
    }

    if (Object.prototype.hasOwnProperty.call(variants, key)) {
      const writer = state.variantWriters.get(key);
      const duplicateDirect = writer === "direct";
      this.host.onError(
        duplicateDirect
          ? "rsgl.duplicateBlockstateVariantEntry"
          : "rsgl.blockstateVariantEntryConflict",
        duplicateDirect
          ? `Blockstate variant '${key}' is declared more than once.`
          : `Blockstate variant '${key}' conflicts with content written by ${writer ?? "the existing root"}.`,
        sourceRange
      );
      return false;
    }

    variants[key] = cloneJsonValue(value);
    state.variantWriters.set(key, "direct");
    if (mappings?.length) {
      state.mappings.push(...mappings);
    } else {
      state.mappings.push(this.host.sourceMapping(blockstateVariantPath(key), sourceRange, context));
    }
    return true;
  }

  /** Appends one direct multipart entry at the current, fully merged index. */
  public appendMultipart(
    state: BlockstateRootState,
    value: JsonValue,
    sourceRange: BlockstateSourceRange,
    context: RsglCompileContext,
    relativeMappings?: readonly RsglMapping[]
  ): number | undefined {
    if (state.mode !== "multipart") {
      this.host.onError(
        "rsgl.blockstateModeConflict",
        "A 'variants' blockstate root cannot receive a multipart entry.",
        sourceRange
      );
      return undefined;
    }

    let multipart = state.content.multipart;
    if (multipart === undefined) {
      multipart = [];
      state.content.multipart = multipart;
    }
    if (!Array.isArray(multipart)) {
      this.host.onError(
        "rsgl.invalidBlockstateMultipartRoot",
        "Blockstate 'multipart' must be an array before a direct entry can be appended.",
        sourceRange
      );
      return undefined;
    }

    const index = multipart.length;
    multipart.push(cloneJsonValue(value));
    const entryPath = blockstateMultipartPath(index);
    if (relativeMappings?.length) {
      state.mappings.push(...relativeMappings.map(mapping => ({
        ...mapping,
        generatedPath: joinGeneratedPath(entryPath, mapping.generatedPath)
      })));
    } else {
      state.mappings.push(this.host.sourceMapping(entryPath, sourceRange, context));
    }
    return index;
  }

  /** Adds the selected empty field only after every ordered operation ran. */
  public finalize(
    state: BlockstateRootState,
    modeOrigin?: BlockstateRootFinalizeOrigin
  ): BlockstateBodyContent {
    if (state.content[state.mode] === undefined) {
      state.content[state.mode] = state.mode === "variants" ? {} : [];
    }
    if (modeOrigin) {
      const modePath = `/${state.mode}`;
      // Some consumers use the first exact mapping while validation uses the
      // latest one. Keep one authoritative header mapping for both contracts,
      // without disturbing base/merge provenance below the selected field.
      const retainedMappings = state.mappings.filter(mapping => mapping.generatedPath !== modePath);
      state.mappings.length = 0;
      state.mappings.push(...retainedMappings, this.host.sourceMapping(
        modePath,
        modeOrigin.sourceRange,
        modeOrigin.context
      ));
    }
    return state;
  }

  private preflight(
    state: BlockstateRootState,
    content: Readonly<Record<string, JsonValue>>,
    sourceRange: BlockstateSourceRange
  ): boolean {
    if (Object.prototype.hasOwnProperty.call(content, "variants") && !isJsonObject(content.variants)) {
      this.host.onError(
        "rsgl.invalidBlockstateVariantsRoot",
        "Blockstate root field 'variants' must be an object.",
        sourceRange
      );
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(content, "multipart") && !Array.isArray(content.multipart)) {
      this.host.onError(
        "rsgl.invalidBlockstateMultipartRoot",
        "Blockstate root field 'multipart' must be an array.",
        sourceRange
      );
      return false;
    }
    const result = preflightBlockstateRootOperand(state.mode, content);
    if (result.compatible) {
      return true;
    }
    this.host.onError(result.diagnostic.code, result.diagnostic.message, sourceRange);
    return false;
  }

  private resetVariantWriters(
    state: BlockstateRootState,
    writer: BlockstateVariantWriter
  ): void {
    state.variantWriters.clear();
    if (!isJsonObject(state.content.variants)) {
      return;
    }
    Object.keys(state.content.variants).forEach(key => state.variantWriters.set(key, writer));
  }

  private recordMergeVariantWriters(
    state: BlockstateRootState,
    mergeResult: MergeResult
  ): void {
    const variants = state.content.variants;
    if (!isJsonObject(variants)) {
      state.variantWriters.clear();
      return;
    }

    for (const key of state.variantWriters.keys()) {
      if (!Object.prototype.hasOwnProperty.call(variants, key)) {
        state.variantWriters.delete(key);
      }
    }
    const appliedVariants = mergeResult.applied.variants;
    if (isJsonObject(appliedVariants)) {
      Object.keys(appliedVariants).forEach(key => state.variantWriters.set(key, "merge"));
    }
  }
}

/** Adapts typed blockstate fragments and mappings to the shared fragment merge engine. */
export class BlockstateContentMerger {
  public constructor(private readonly host: BlockstateContentMergeHost) { }

  public apply(
    result: BlockstateBodyContent,
    content: Record<string, JsonValue>,
    mode: FragmentMergeMode,
    sourceRange: BlockstateSourceRange,
    context: RsglCompileContext,
    mappings?: readonly RsglMapping[]
  ): MergeResult {
    const mergeResult = fragmentMergeEngine.apply(
      result.content,
      { content, mode, sourceRange },
      blockstateFragmentMergePolicy
    );
    for (const diagnostic of mergeResult.diagnostics) {
      this.host.onError(diagnostic.code, diagnostic.message, diagnostic.range);
    }

    if (mappings?.length) {
      let emittedPublicMapping = false;
      for (const mapping of mappings) {
        if (!mappingTargetsAppliedContent(mapping.generatedPath, mergeResult.applied)) {
          continue;
        }
        emittedPublicMapping ||= !mapping.validationOnly;
        result.mappings.push({
          ...mapping,
          generatedPath: offsetFragmentMappingPath(mapping.generatedPath, mergeResult.arrayOffsets)
        });
      }
      if (emittedPublicMapping) {
        return mergeResult;
      }
    }

    result.mappings.push(...this.objectMappingsDeep(mergeResult, sourceRange, context));
    return mergeResult;
  }

  private objectMappingsDeep(
    mergeResult: MergeResult,
    sourceRange: BlockstateSourceRange,
    context: RsglCompileContext
  ): RsglMapping[] {
    const mappings: RsglMapping[] = [];
    for (const [key, value] of Object.entries(mergeResult.applied)) {
      this.collectValueMappings(
        mappings,
        appendGeneratedPath("", key),
        value,
        sourceRange,
        context,
        mergeResult.arrayOffsets
      );
    }
    return mappings;
  }

  private collectValueMappings(
    mappings: RsglMapping[],
    generatedPath: string,
    value: JsonValue,
    sourceRange: BlockstateSourceRange,
    context: RsglCompileContext,
    arrayOffsets: ReadonlyMap<string, number>
  ): void {
    const targetPath = offsetFragmentMappingPath(generatedPath, arrayOffsets);
    mappings.push(this.host.sourceMapping(targetPath, sourceRange, context));
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        this.collectValueMappings(
          mappings,
          appendGeneratedPath(generatedPath, String(index)),
          item,
          sourceRange,
          context,
          arrayOffsets
        );
      });
    } else if (isJsonObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        this.collectValueMappings(
          mappings,
          appendGeneratedPath(generatedPath, key),
          item,
          sourceRange,
          context,
          arrayOffsets
        );
      }
    }
  }
}
