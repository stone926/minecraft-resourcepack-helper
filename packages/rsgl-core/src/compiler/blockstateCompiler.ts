import {
  MultipartBodyNode,
  MultipartSectionStatementNode,
  ResourceBodyNode,
  ResourceDeclNode,
  ResourceStatementNode,
  UseDeclNode,
  VariantBodyNode,
  VariantSectionStatementNode
} from "../parser";
import {
  appendBlockstateContent,
  mergeBlockstateContent,
  mergeBlockstateFragment,
  overrideBlockstateContent,
  RsglBlockstateFragment,
  RsglBlockstateFragmentOptions
} from "./blockstateFragments";
import { blockstateVariantKey } from "./blockstateKeys";
import {
  blockstateMultipartPath,
  blockstateVariantPath,
  currentMultipartLength,
  isMultipartEntryPath,
  isVariantEntryPath,
  normalizeJsonValue,
  offsetMultipartMappings,
  staticText
} from "./compilerHelpers";
import { evaluateExpression } from "./evaluate";
import { JsonValue, ResourceUnit, RsglMapping } from "./ir";
import { isJsonObject } from "./jsonValues";
import { forEachLoopContext } from "./looping";
import { parseResourceId, resourceOutputPath } from "./resourceIds";
import { appendGeneratedPath } from "./sourcePaths";
import { RsglCompileContext, TemplateExpansion, templateResourceBody } from "./templateExpansion";

type SourceRange = { start: number; end: number };

export interface BlockstateCompileOptions {
  expandUse: (statement: UseDeclNode, context: RsglCompileContext) => TemplateExpansion | undefined;
  onError: (code: string, message: string, range: SourceRange) => void;
  sourceMap: (
    outputPath: string,
    node: { range: SourceRange },
    context: RsglCompileContext,
    mappings: RsglMapping[]
  ) => ResourceUnit["sourceMap"];
  sourceMapping: (generatedPath: string, sourceRange: SourceRange, context: RsglCompileContext) => RsglMapping;
}

type BlockstateBodyCompileResult = {
  content: Record<string, JsonValue>;
  mappings: RsglMapping[];
};

type VariantEntriesCompileResult = {
  entries: Record<string, JsonValue>;
  mappings: RsglMapping[];
};

type MultipartEntriesCompileResult = {
  entries: JsonValue[];
  mappings: RsglMapping[];
};

export function compileBlockstateResource(
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  options: BlockstateCompileOptions
): ResourceUnit | null {
  return new BlockstateCompiler(options).compile(statement, context);
}

class BlockstateCompiler {
  public constructor(private readonly options: BlockstateCompileOptions) { }

  public compile(statement: ResourceDeclNode, context: RsglCompileContext): ResourceUnit | null {
    const idValue = statement.id ? staticText(statement.id, context) : null;
    const id = idValue ? parseResourceId(idValue, context.namespace) : null;
    if (!id || !statement.id) {
      this.error("rsgl.compileMissingResourceId", "Blockstate declaration requires a static id.", statement.range);
      return null;
    }
    const body = this.compileBody(statement.body, context);
    const outputPath = resourceOutputPath("blockstate", id);
    return {
      id,
      kind: "blockstate",
      outputPath,
      content: body.content,
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: this.options.sourceMap(outputPath, statement, context, body.mappings)
    };
  }

  private compileBody(body: ResourceBodyNode, context: RsglCompileContext): BlockstateBodyCompileResult {
    const result: BlockstateBodyCompileResult = { content: {}, mappings: [] };
    for (const statement of body.statements) {
      this.compileBodyStatement(statement, context, result);
    }
    return result;
  }

  private compileBodyStatement(
    statement: ResourceStatementNode,
    context: RsglCompileContext,
    result: BlockstateBodyCompileResult
  ): void {
    const fragmentOptions = this.fragmentOptions();
    if (statement.kind === "VariantsSection") {
      const variants = this.compileVariantEntries(statement.entries, context);
      mergeBlockstateFragment(result.content, { variants: variants.entries }, statement.range, fragmentOptions);
      result.mappings.push(this.sourceMapping("/variants", statement.range, context), ...variants.mappings);
    } else if (statement.kind === "MultipartSection") {
      const multipart = this.compileMultipartEntries(statement.entries, context, currentMultipartLength(result.content));
      mergeBlockstateFragment(result.content, { multipart: multipart.entries }, statement.range, fragmentOptions);
      result.mappings.push(this.sourceMapping("/multipart", statement.range, context), ...multipart.mappings);
    } else if (statement.kind === "UseDecl") {
      const fragment = this.compileUse(statement, context);
      const multipartOffset = currentMultipartLength(result.content);
      mergeBlockstateFragment(result.content, fragment, statement.range, fragmentOptions);
      result.mappings.push(...this.fragmentMappings(fragment, statement.range, context, multipartOffset));
    } else if (statement.kind === "LetDecl") {
      this.compileLet(statement, context);
    } else if (statement.kind === "ForStmt") {
      const body = statement.body;
      if (body.kind !== "ResourceBody") {
        return;
      }
      forEachLoopContext(statement, context, (code, message, range) => this.error(code, message, range), loopContext => {
        const loopContent = this.compileBody(body, loopContext);
        const multipartOffset = currentMultipartLength(result.content);
        mergeBlockstateContent(result.content, loopContent.content, statement.range, fragmentOptions);
        result.mappings.push(...offsetMultipartMappings(loopContent.mappings, multipartOffset));
      });
    } else if (statement.kind === "IfStmt") {
      const body = evaluateExpression(statement.condition, context) ? statement.thenBody : statement.elseBody;
      if (body?.kind === "ResourceBody") {
        const branchContent = this.compileBody(body, context);
        const multipartOffset = currentMultipartLength(result.content);
        mergeBlockstateContent(result.content, branchContent.content, statement.range, fragmentOptions);
        result.mappings.push(...offsetMultipartMappings(branchContent.mappings, multipartOffset));
      }
    } else if (statement.kind === "RawJsonStmt") {
      const value = normalizeJsonValue(evaluateExpression(statement.value, context));
      if (isJsonObject(value)) {
        const multipartOffset = currentMultipartLength(result.content);
        mergeBlockstateContent(result.content, value, statement.range, fragmentOptions);
        result.mappings.push(...this.objectMappings(value, statement.range, context, multipartOffset));
      } else {
        this.error("rsgl.invalidRawJsonFragment", "raw_json must evaluate to an object fragment.", statement.value.range);
      }
    } else if (statement.kind === "OverrideStmt") {
      const value = normalizeJsonValue(evaluateExpression(statement.value, context));
      if (isJsonObject(value)) {
        const applied = overrideBlockstateContent(result.content, value, statement.create, statement.range, fragmentOptions);
        result.mappings.push(...this.objectMappings(applied, statement.range, context, 0));
      } else {
        this.error("rsgl.invalidOverrideFragment", "override must evaluate to an object fragment.", statement.value.range);
      }
    } else if (statement.kind === "AppendStmt") {
      const value = normalizeJsonValue(evaluateExpression(statement.value, context));
      if (isJsonObject(value)) {
        const appended = appendBlockstateContent(result.content, value, statement.range, fragmentOptions);
        result.mappings.push(...this.objectMappings(appended.applied, statement.range, context, appended.multipartOffset));
      } else {
        this.error("rsgl.invalidAppendFragment", "append must evaluate to an object fragment.", statement.value.range);
      }
    }
  }

  private compileVariantEntries(
    statements: VariantSectionStatementNode[],
    context: RsglCompileContext
  ): VariantEntriesCompileResult {
    const result: VariantEntriesCompileResult = { entries: {}, mappings: [] };
    for (const statement of statements) {
      this.compileVariantStatement(statement, context, result);
    }
    return result;
  }

  private compileVariantBody(
    body: VariantBodyNode,
    context: RsglCompileContext,
    result: VariantEntriesCompileResult
  ): void {
    for (const statement of body.statements) {
      this.compileVariantStatement(statement, context, result);
    }
  }

  private compileVariantStatement(
    statement: VariantSectionStatementNode,
    context: RsglCompileContext,
    result: VariantEntriesCompileResult
  ): void {
    if (statement.kind === "VariantEntry") {
      const state = blockstateVariantKey(normalizeJsonValue(evaluateExpression(statement.state, context)));
      result.entries[state] = normalizeJsonValue(evaluateExpression(statement.value, context));
      result.mappings.push(this.sourceMapping(blockstateVariantPath(state), statement.range, context));
    } else if (statement.kind === "LetDecl") {
      this.compileLet(statement, context);
    } else if (statement.kind === "UseDecl") {
      const fragment = this.compileUse(statement, context);
      if (fragment.multipart) {
        this.error("rsgl.incompatibleBlockstateFragment", "Multipart template fragments cannot be used inside a variants section.", statement.range);
      }
      if (fragment.variants) {
        Object.assign(result.entries, fragment.variants);
        result.mappings.push(...this.fragmentVariantMappings(fragment, statement.range, context));
      }
    } else if (statement.kind === "ForStmt") {
      const body = statement.body;
      if (body.kind !== "VariantBody") {
        return;
      }
      forEachLoopContext(statement, context, (code, message, range) => this.error(code, message, range), loopContext => {
        this.compileVariantBody(body, loopContext, result);
      });
    } else if (statement.kind === "IfStmt") {
      const body = evaluateExpression(statement.condition, context) ? statement.thenBody : statement.elseBody;
      if (body?.kind === "VariantBody") {
        this.compileVariantBody(body, context, result);
      }
    }
  }

  private compileMultipartEntries(
    statements: MultipartSectionStatementNode[],
    context: RsglCompileContext,
    startIndex = 0
  ): MultipartEntriesCompileResult {
    const result: MultipartEntriesCompileResult = { entries: [], mappings: [] };
    for (const statement of statements) {
      this.compileMultipartStatement(statement, context, result, startIndex);
    }
    return result;
  }

  private compileMultipartBody(
    body: MultipartBodyNode,
    context: RsglCompileContext,
    result: MultipartEntriesCompileResult,
    startIndex: number
  ): void {
    for (const statement of body.statements) {
      this.compileMultipartStatement(statement, context, result, startIndex);
    }
  }

  private compileMultipartStatement(
    statement: MultipartSectionStatementNode,
    context: RsglCompileContext,
    result: MultipartEntriesCompileResult,
    startIndex: number
  ): void {
    if (statement.kind === "MultipartEntry") {
      const value: Record<string, JsonValue> = {
        apply: normalizeJsonValue(evaluateExpression(statement.apply, context))
      };
      if (statement.when) {
        value.when = normalizeJsonValue(evaluateExpression(statement.when, context));
      }
      const index = startIndex + result.entries.length;
      result.entries.push(value);
      result.mappings.push(this.sourceMapping(blockstateMultipartPath(index), statement.range, context));
    } else if (statement.kind === "LetDecl") {
      this.compileLet(statement, context);
    } else if (statement.kind === "UseDecl") {
      const fragment = this.compileUse(statement, context);
      if (fragment.variants) {
        this.error("rsgl.incompatibleBlockstateFragment", "Variant template fragments cannot be used inside a multipart section.", statement.range);
      }
      if (fragment.multipart) {
        const offset = startIndex + result.entries.length;
        result.entries.push(...fragment.multipart);
        result.mappings.push(...this.fragmentMultipartMappings(fragment, statement.range, context, offset));
      }
    } else if (statement.kind === "ForStmt") {
      const body = statement.body;
      if (body.kind !== "MultipartBody") {
        return;
      }
      forEachLoopContext(statement, context, (code, message, range) => this.error(code, message, range), loopContext => {
        this.compileMultipartBody(body, loopContext, result, startIndex);
      });
    } else if (statement.kind === "IfStmt") {
      const body = evaluateExpression(statement.condition, context) ? statement.thenBody : statement.elseBody;
      if (body?.kind === "MultipartBody") {
        this.compileMultipartBody(body, context, result, startIndex);
      }
    }
  }

  private compileUse(useStatement: UseDeclNode, context: RsglCompileContext): RsglBlockstateFragment {
    return this.compileUserFragment(useStatement, context) ?? {};
  }

  private compileUserFragment(
    useStatement: UseDeclNode,
    context: RsglCompileContext
  ): RsglBlockstateFragment | undefined {
    const expansion = this.options.expandUse(useStatement, context);
    if (!expansion) {
      return undefined;
    }
    const resourceBody = templateResourceBody(expansion.definition.node.body);
    if (!resourceBody) {
      this.error(
        "rsgl.invalidTemplateContext",
        `Template '${expansion.definition.name}' emits resources and cannot be used inside a blockstate body.`,
        useStatement.range
      );
      return undefined;
    }
    const body = this.compileBody(resourceBody, expansion.context);
    const content = body.content;
    const fragment: RsglBlockstateFragment = {};
    if (isJsonObject(content.variants)) {
      fragment.variants = content.variants;
    }
    if (Array.isArray(content.multipart)) {
      fragment.multipart = content.multipart;
    }
    fragment.mappings = body.mappings;
    return fragment;
  }

  private fragmentMappings(
    fragment: RsglBlockstateFragment,
    sourceRange: SourceRange,
    context: RsglCompileContext,
    multipartOffset: number
  ): RsglMapping[] {
    if (fragment.mappings?.length) {
      return offsetMultipartMappings(fragment.mappings, multipartOffset);
    }
    return [
      ...this.fragmentVariantMappings(fragment, sourceRange, context, true),
      ...this.fragmentMultipartMappings(fragment, sourceRange, context, multipartOffset, true)
    ];
  }

  private fragmentVariantMappings(
    fragment: RsglBlockstateFragment,
    sourceRange: SourceRange,
    context: RsglCompileContext,
    includeSection = false
  ): RsglMapping[] {
    if (fragment.mappings?.length) {
      return fragment.mappings.filter(mapping => isVariantEntryPath(mapping.generatedPath));
    }
    if (!fragment.variants) {
      return [];
    }
    const mappings = includeSection ? [this.sourceMapping("/variants", sourceRange, context)] : [];
    for (const key of Object.keys(fragment.variants)) {
      mappings.push(this.sourceMapping(blockstateVariantPath(key), sourceRange, context));
    }
    return mappings;
  }

  private fragmentMultipartMappings(
    fragment: RsglBlockstateFragment,
    sourceRange: SourceRange,
    context: RsglCompileContext,
    offset: number,
    includeSection = false
  ): RsglMapping[] {
    if (fragment.mappings?.length) {
      return offsetMultipartMappings(fragment.mappings.filter(mapping => isMultipartEntryPath(mapping.generatedPath)), offset);
    }
    if (!fragment.multipart) {
      return [];
    }
    const mappings = includeSection ? [this.sourceMapping("/multipart", sourceRange, context)] : [];
    fragment.multipart.forEach((_, index) => {
      mappings.push(this.sourceMapping(blockstateMultipartPath(offset + index), sourceRange, context));
    });
    return mappings;
  }

  private objectMappings(
    value: Record<string, JsonValue>,
    sourceRange: SourceRange,
    context: RsglCompileContext,
    multipartOffset: number
  ): RsglMapping[] {
    const mappings: RsglMapping[] = [];
    for (const [key, entryValue] of Object.entries(value)) {
      if (key === "variants" && isJsonObject(entryValue)) {
        mappings.push(this.sourceMapping("/variants", sourceRange, context));
        for (const variantKey of Object.keys(entryValue)) {
          mappings.push(this.sourceMapping(blockstateVariantPath(variantKey), sourceRange, context));
        }
      } else if (key === "multipart" && Array.isArray(entryValue)) {
        mappings.push(this.sourceMapping("/multipart", sourceRange, context));
        entryValue.forEach((_, index) => {
          mappings.push(this.sourceMapping(blockstateMultipartPath(multipartOffset + index), sourceRange, context));
        });
      } else {
        mappings.push(this.sourceMapping(appendGeneratedPath("", key), sourceRange, context));
      }
    }
    return mappings;
  }

  private compileLet(
    statement: Extract<ResourceStatementNode, { kind: "LetDecl" }>,
    context: RsglCompileContext
  ): void {
    if (statement.name) {
      context.variables.set(statement.name.text, evaluateExpression(statement.value, context));
    }
  }

  private fragmentOptions(): RsglBlockstateFragmentOptions {
    return {
      onError: (code, message, range) => this.error(code, message, range)
    };
  }

  private sourceMapping(generatedPath: string, sourceRange: SourceRange, context: RsglCompileContext): RsglMapping {
    return this.options.sourceMapping(generatedPath, sourceRange, context);
  }

  private error(code: string, message: string, range: SourceRange): void {
    this.options.onError(code, message, range);
  }
}
