import {
  ExprNode,
  MultipartBodyNode,
  MultipartSectionStatementNode,
  ResourceBodyNode,
  ResourceDeclNode,
  ResourceStatementNode,
  UseDeclNode,
  VariantBodyNode,
  VariantSectionStatementNode
} from "../parser";
import { applyBaseDocument } from "./base/application";
import {
  BlockstateContentMerger,
  type BlockstateBodyContent
} from "./blockstateContentMerge";
import { RsglBlockstateFragment } from "./blockstateFragments";
import { blockstateVariantKey } from "./blockstateKeys";
import {
  blockstateMultipartPath,
  blockstateVariantPath,
  normalizeJsonValue,
  staticText
} from "./compilerHelpers";
import {
  bindEvaluationValue,
  evaluateExpression,
  expressionEvaluationOrigin,
  expressionEvaluationPathOrigins
} from "./evaluate";
import { JsonValue, ResourceUnit, RsglMapping } from "./ir";
import { isJsonObject } from "./jsonValues";
import { forEachLoopContext } from "./looping";
import { parseResourceId, resourceOutputPath } from "./resourceIds";
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
  private readonly contentMerger: BlockstateContentMerger;

  public constructor(private readonly options: BlockstateCompileOptions) {
    this.contentMerger = new BlockstateContentMerger({
      onError: (code, message, range) => this.error(code, message, range),
      sourceMapping: (generatedPath, sourceRange, context) =>
        this.sourceMapping(generatedPath, sourceRange, context)
    });
  }

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

  private compileBody(
    body: ResourceBodyNode,
    context: RsglCompileContext,
    allowBase = true
  ): BlockstateBodyContent {
    const result: BlockstateBodyContent = { content: {}, mappings: [] };
    body.statements.forEach((statement, index) => {
      this.compileBodyStatement(statement, context, result, allowBase, index === 0);
    });
    return result;
  }

  private compileBodyStatement(
    statement: ResourceStatementNode,
    context: RsglCompileContext,
    result: BlockstateBodyContent,
    allowBase: boolean,
    isFirstStatement: boolean
  ): void {
    if (statement.kind === "VariantsSection") {
      const variants = this.compileVariantEntries(statement.entries, context);
      this.contentMerger.apply(
        result,
        { variants: variants.entries },
        "deep",
        statement.range,
        context,
        [this.sourceMapping("/variants", statement.range, context), ...variants.mappings]
      );
    } else if (statement.kind === "MultipartSection") {
      const multipart = this.compileMultipartEntries(statement.entries, context);
      this.contentMerger.apply(
        result,
        { multipart: multipart.entries },
        "deep",
        statement.range,
        context,
        [this.sourceMapping("/multipart", statement.range, context), ...multipart.mappings]
      );
    } else if (statement.kind === "UseDecl") {
      const fragment = this.compileUse(statement, context);
      this.contentMerger.apply(
        result,
        fragment.content,
        "deep",
        statement.range,
        context,
        fragment.mappings
      );
    } else if (statement.kind === "LetDecl") {
      this.compileLet(statement, context);
    } else if (statement.kind === "ForStmt") {
      const body = statement.body;
      if (body.kind !== "ResourceBody") {
        return;
      }
      forEachLoopContext(statement, context, (code, message, range) => this.error(code, message, range), loopContext => {
        const loopContent = this.compileBody(body, loopContext, false);
        this.contentMerger.apply(
          result,
          loopContent.content,
          "deep",
          statement.range,
          loopContext,
          loopContent.mappings
        );
      });
    } else if (statement.kind === "IfStmt") {
      const body = evaluateExpression(statement.condition, context) ? statement.thenBody : statement.elseBody;
      if (body?.kind === "ResourceBody") {
        const branchContent = this.compileBody(body, context, false);
        this.contentMerger.apply(
          result,
          branchContent.content,
          "deep",
          statement.range,
          context,
          branchContent.mappings
        );
      }
    } else if (statement.kind === "BaseStmt") {
      this.applyBaseStatement(result, statement, context, allowBase, isFirstStatement);
    } else if (statement.kind === "MergeStmt") {
      const value = normalizeJsonValue(evaluateExpression(statement.value, context));
      if (isJsonObject(value)) {
        const validationMappings = expressionEvaluationPathOrigins(statement.value, context, "").map(origin => ({
          ...this.sourceMapping(origin.generatedPath, statement.value.range, context),
          validationOrigin: origin,
          validationOnly: true
        }));
        this.contentMerger.apply(
          result,
          value,
          statement.mode,
          statement.range,
          context,
          validationMappings
        );
      } else {
        this.error("rsgl.invalidMergeFragment", "merge must evaluate to an object fragment.", statement.value.range);
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
      result.mappings.push(...this.sourceMappingsForExpression(
        blockstateVariantPath(state),
        statement.range,
        statement.value,
        context
      ));
    } else if (statement.kind === "LetDecl") {
      this.compileLet(statement, context);
    } else if (statement.kind === "UseDecl") {
      const fragment = this.compileUse(statement, context);
      const variants = fragment.content.variants;
      this.reportIncompatibleSectionFragment(fragment, "variants", statement.range);
      if (isJsonObject(variants)) {
        Object.assign(result.entries, variants);
        result.mappings.push(...this.contentMerger.fragmentVariantMappings(fragment, statement.range, context));
      } else if (variants !== undefined) {
        this.error("rsgl.incompatibleBlockstateFragment", "A variants-section template must produce an object 'variants' field.", statement.range);
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
      result.mappings.push(...this.sourceMappingsForExpression(
        blockstateMultipartPath(index),
        statement.range,
        statement.apply,
        context
      ));
    } else if (statement.kind === "LetDecl") {
      this.compileLet(statement, context);
    } else if (statement.kind === "UseDecl") {
      const fragment = this.compileUse(statement, context);
      const multipart = fragment.content.multipart;
      this.reportIncompatibleSectionFragment(fragment, "multipart", statement.range);
      if (Array.isArray(multipart)) {
        const offset = startIndex + result.entries.length;
        result.entries.push(...multipart);
        result.mappings.push(...this.contentMerger.fragmentMultipartMappings(fragment, statement.range, context, offset));
      } else if (multipart !== undefined) {
        this.error("rsgl.incompatibleBlockstateFragment", "A multipart-section template must produce an array 'multipart' field.", statement.range);
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
    return this.compileUserFragment(useStatement, context) ?? { content: {} };
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
    const body = this.compileBody(resourceBody, expansion.context, false);
    return { content: body.content, mappings: body.mappings };
  }

  private reportIncompatibleSectionFragment(
    fragment: RsglBlockstateFragment,
    expectedField: "variants" | "multipart",
    range: SourceRange
  ): void {
    const incompatibleFields = Object.keys(fragment.content).filter(key => key !== expectedField);
    if (incompatibleFields.length === 0) {
      return;
    }
    this.error(
      "rsgl.incompatibleBlockstateFragment",
      `A template used inside a ${expectedField} section cannot produce fields: ${incompatibleFields.join(", ")}.`,
      range
    );
  }

  private applyBaseStatement(
    result: BlockstateBodyContent,
    statement: Extract<ResourceStatementNode, { kind: "BaseStmt" }>,
    context: RsglCompileContext,
    allowBase: boolean,
    isFirstStatement: boolean
  ): void {
    const base = applyBaseDocument(statement, context, {
      allowBase,
      isRoot: true,
      isFirstStatement,
      onError: (code, message, range) => this.error(code, message, range),
      createMapping: (generatedPath, sourceRange, mappingContext) =>
        this.sourceMapping(generatedPath, sourceRange, mappingContext)
    });
    if (!base) {
      return;
    }
    result.content = base.content;
    result.mappings.push(...base.mappings);
    if (result.content.variants !== undefined && result.content.multipart !== undefined) {
      this.error(
        "rsgl.blockstateSectionConflict",
        "A blockstate base document must use either variants or multipart, not both.",
        statement.range
      );
    }
  }

  private compileLet(
    statement: Extract<ResourceStatementNode, { kind: "LetDecl" }>,
    context: RsglCompileContext
  ): void {
    if (statement.name) {
      bindEvaluationValue(
        context,
        statement.name.text,
        evaluateExpression(statement.value, context),
        expressionEvaluationOrigin(statement.value, context)
      );
    }
  }

  private sourceMapping(generatedPath: string, sourceRange: SourceRange, context: RsglCompileContext): RsglMapping {
    return this.options.sourceMapping(generatedPath, sourceRange, context);
  }

  private sourceMappingsForExpression(
    generatedPath: string,
    fallbackRange: SourceRange,
    expression: ExprNode,
    context: RsglCompileContext
  ): RsglMapping[] {
    return [
      this.sourceMapping(generatedPath, fallbackRange, context),
      ...expressionEvaluationPathOrigins(expression, context, generatedPath).map(origin => ({
        ...this.sourceMapping(origin.generatedPath, fallbackRange, context),
        validationOrigin: origin,
        validationOnly: true
      }))
    ];
  }

  private error(code: string, message: string, range: SourceRange): void {
    this.options.onError(code, message, range);
  }
}
