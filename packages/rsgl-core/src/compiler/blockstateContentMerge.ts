import type { RsglBlockstateFragment } from "./blockstateFragments";
import {
  blockstateMultipartPath,
  blockstateVariantPath,
  isMultipartEntryPath,
  isVariantEntryPath,
  offsetMultipartMappings
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
import { isJsonObject } from "./jsonValues";
import { appendGeneratedPath } from "./sourcePaths";
import type { RsglCompileContext } from "./templateExpansion";

export type BlockstateSourceRange = { start: number; end: number };

export interface BlockstateBodyContent {
  content: Record<string, JsonValue>;
  mappings: RsglMapping[];
}

export interface BlockstateContentMergeHost {
  onError: (code: string, message: string, range: BlockstateSourceRange) => void;
  sourceMapping: (
    generatedPath: string,
    sourceRange: BlockstateSourceRange,
    context: RsglCompileContext
  ) => RsglMapping;
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
    mappings?: RsglMapping[]
  ): void {
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
        return;
      }
    }

    result.mappings.push(...this.objectMappingsDeep(mergeResult, sourceRange, context));
  }

  public fragmentVariantMappings(
    fragment: RsglBlockstateFragment,
    sourceRange: BlockstateSourceRange,
    context: RsglCompileContext,
    includeSection = false
  ): RsglMapping[] {
    if (fragment.mappings?.length) {
      return fragment.mappings.filter(mapping => isVariantEntryPath(mapping.generatedPath));
    }
    const variants = fragment.content.variants;
    if (!isJsonObject(variants)) {
      return [];
    }
    const mappings = includeSection ? [this.host.sourceMapping("/variants", sourceRange, context)] : [];
    for (const key of Object.keys(variants)) {
      mappings.push(this.host.sourceMapping(blockstateVariantPath(key), sourceRange, context));
    }
    return mappings;
  }

  public fragmentMultipartMappings(
    fragment: RsglBlockstateFragment,
    sourceRange: BlockstateSourceRange,
    context: RsglCompileContext,
    offset: number,
    includeSection = false
  ): RsglMapping[] {
    if (fragment.mappings?.length) {
      return offsetMultipartMappings(
        fragment.mappings.filter(mapping => isMultipartEntryPath(mapping.generatedPath)),
        offset
      );
    }
    const multipart = fragment.content.multipart;
    if (!Array.isArray(multipart)) {
      return [];
    }
    const mappings = includeSection ? [this.host.sourceMapping("/multipart", sourceRange, context)] : [];
    multipart.forEach((_, index) => {
      mappings.push(this.host.sourceMapping(blockstateMultipartPath(offset + index), sourceRange, context));
    });
    return mappings;
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
