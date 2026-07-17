import type { ExprNode, ResourceDeclNode, ResourceStatementNode, TextRange } from "../parser";
import {
  isRsglGenericJsonResourceKind,
  type RsglResourceKind
} from "../resourceKinds";
import type {
  RsglTemplateCallerContext,
  TemplateOutputDispatch
} from "../templateOutput";
import { compileAtlasSpecialStatement } from "./atlasSugar";
import { compileBlockstateResource, type BlockstateCompileOptions } from "./blockstateCompiler";
import { DEFAULT_MAX_ITEM_MODEL_DEPTH } from "./compileConfiguration";
import { compileEquipmentLayerStatement } from "./equipmentSugar";
import type { RsglTemplateDefinition } from "./environment";
import {
  childEvaluationContext,
  type EvaluationContext,
  type EvaluationResult,
  evaluateExpressionResult,
  hasEvaluationValueBinding
} from "./evaluate";
import type { RsglResourceValueObservation } from "./evaluatedResourceValues";
import type { JsonValue, RsglMapping, RsglSourceMap } from "./ir";
import { executeItemResourceBody, type ItemOperationExecutorHost } from "./itemOperationExecutor";
import {
  compileJsonResourceUseFragment,
  type JsonResourceFragmentKind
} from "./jsonResourceFragments";
import type { JsonValueSinkOptions } from "./jsonValueLowerer";
import { compileModelGeometryStatement, type ModelGeometryDslOptions } from "./modelGeometryDsl";
import {
  compilePackResource,
  compilePackSpecialStatement,
  type PackOverlayCompileOptions
} from "./packOverlayCompiler";
import {
  type ResourceBodyCompileOptions,
  type ResourceBodyFragment,
  type ResourceBodyMapping,
  type ResourceBodySpecialResult,
  resourceBodyToObject
} from "./resourceBody";
import type { ResourceDeclarationCompilerHost } from "./resourceCompiler";
import type {
  RsglCompileContext,
  TemplateExpansion
} from "./templateExpansion";

export interface ResourceBodyLoweringHost {
  readonly fileName: string;
  readonly maxItemModelDepth?: number;
  readonly moduleValueBindingNames: ReadonlySet<string>;
  blockstateCompileOptions(): BlockstateCompileOptions;
  packOverlayOptions(): PackOverlayCompileOptions;
  compileResourceBodyFragment(
    statement: Extract<ResourceStatementNode, { kind: "UseDecl" }>,
    context: RsglCompileContext,
    kind: Exclude<RsglResourceKind, "blockstate">
  ): ResourceBodyFragment | undefined;
  findTemplateDefinition(
    expression: ExprNode,
    context: RsglCompileContext
  ): RsglTemplateDefinition | undefined;
  createTemplateExpansion(
    expression: ExprNode,
    context: RsglCompileContext,
    definition?: RsglTemplateDefinition
  ): TemplateExpansion | undefined;
  resolveTemplateDispatch(
    definition: RsglTemplateDefinition,
    callerContext: RsglTemplateCallerContext
  ): TemplateOutputDispatch;
  sourceMap(
    outputPath: string,
    node: { range: TextRange },
    context: RsglCompileContext,
    mappings?: RsglMapping[]
  ): RsglSourceMap;
  sourceMapping(
    generatedPath: string,
    sourceRange: TextRange,
    context: Pick<EvaluationContext, "sourceFile" | "mappingReason" | "expansionStack">
  ): RsglMapping;
  onError(code: string, message: string, range: TextRange, fileName?: string): void;
  onWarning(code: string, message: string, range: TextRange, fileName?: string): void;
  onInvalidJsonValue(): void;
  onResourceValueObservation(observation: RsglResourceValueObservation): void;
}

interface CachedResourceExpressionResult {
  readonly context: EvaluationContext;
  readonly result: EvaluationResult;
}

/**
 * Lowers resource bodies and supplies the specialized compiler hosts required
 * by resource, item, model-geometry, blockstate, and pack backends.
 */
export class ResourceBodyLowering {
  public constructor(private readonly host: ResourceBodyLoweringHost) {}

  public resourceDeclarationCompilerHost(): ResourceDeclarationCompilerHost {
    const expressionResults = new Map<ExprNode, CachedResourceExpressionResult>();
    return {
      fileName: this.host.fileName,
      compileBlockstate: (statement, context) =>
        compileBlockstateResource(statement, context, this.host.blockstateCompileOptions()),
      compilePack: (statement, context) =>
        compilePackResource(statement, context, this.host.packOverlayOptions()),
      compileBody: (body, context, resourceKind) =>
        this.resourceBodyToObjectWithMappings(
          body,
          context,
          { ...this.resourceBodyFragmentOptions(resourceKind), allowBase: true }
        ),
      compileItemBody: (body, context) => this.compileItemBody(body, context),
      compileJsonBody: (body, context, fragmentKind) =>
        this.resourceBodyToObjectWithMappings(
          body,
          context,
          { ...this.jsonResourceFragmentOptions(fragmentKind), allowBase: true }
        ),
      compileRawBody: (body, context, resourceKind) =>
        this.resourceBodyToObjectWithRawMappings(
          body,
          context,
          { ...this.resourceBodyFragmentOptions(resourceKind), allowBase: true }
        ),
      onError: (code, message, range) => this.host.onError(code, message, range),
      sourceMap: (outputPath, node, context, mappings) =>
        this.host.sourceMap(outputPath, node, context, mappings),
      sourceMapping: (generatedPath, sourceRange, context) =>
        this.host.sourceMapping(generatedPath, sourceRange, context),
      evaluateResult: (expression, context) => {
        const cached = expressionResults.get(expression);
        if (cached?.context === context) {
          return cached.result;
        }
        const result = evaluateExpressionResult(expression, context);
        expressionResults.set(expression, { context, result });
        return result;
      }
    };
  }

  public resourceBodyToObject(
    body: ResourceDeclNode["body"],
    context: RsglCompileContext,
    options: ResourceBodyCompileOptions = {}
  ): Record<string, JsonValue> {
    if (body.kind !== "ResourceBody") {
      this.host.onError(
        "rsgl.invalidResourceBody",
        "A blockstate root body cannot be compiled by the generic resource-body compiler.",
        body.range
      );
      return {};
    }
    return resourceBodyToObject(body, context, {
      ...options,
      onError: (code, message, range, fileName) => this.host.onError(code, message, range, fileName)
    });
  }

  public resourceBodyToObjectWithMappings(
    body: ResourceDeclNode["body"],
    context: RsglCompileContext,
    options: ResourceBodyCompileOptions = {}
  ): { content: Record<string, JsonValue>; mappings: RsglMapping[] } {
    const bodyWithRawMappings = this.resourceBodyToObjectWithRawMappings(body, context, options);
    return {
      content: bodyWithRawMappings.content,
      mappings: bodyWithRawMappings.mappings.map(mapping => ({
        ...this.host.sourceMapping(mapping.generatedPath, mapping.sourceRange, mapping.context),
        ...(mapping.validationOrigin ? { validationOrigin: mapping.validationOrigin } : {}),
        ...(mapping.validationOnly ? { validationOnly: true } : {})
      }))
    };
  }

  public resourceBodyToObjectWithRawMappings(
    body: ResourceDeclNode["body"],
    context: RsglCompileContext,
    options: ResourceBodyCompileOptions = {}
  ): { content: Record<string, JsonValue>; mappings: ResourceBodyMapping[] } {
    if (body.kind !== "ResourceBody") {
      this.host.onError(
        "rsgl.invalidResourceBody",
        "A blockstate root body cannot be compiled by the generic resource-body compiler.",
        body.range
      );
      return { content: {}, mappings: [] };
    }
    const mappings: ResourceBodyMapping[] = [];
    const content = resourceBodyToObject(body, context, {
      ...options,
      onError: (code, message, range, fileName) => this.host.onError(code, message, range, fileName),
      onMapping: mapping => {
        mappings.push(mapping);
        options.onMapping?.(mapping);
      }
    });
    return { content, mappings };
  }

  public packResourceBodyOptions(): ResourceBodyCompileOptions {
    return {
      ...this.resourceBodyFragmentOptions("pack"),
      onSpecialStatement: (statement, context) =>
        compilePackSpecialStatement(statement, context, this.host.packOverlayOptions())
    };
  }

  public compileTemplateFragmentBody(
    body: ResourceDeclNode["body"],
    context: RsglCompileContext,
    kind: Exclude<RsglResourceKind, "blockstate">
  ): { content: Record<string, JsonValue>; mappings: ResourceBodyMapping[] } {
    return this.resourceBodyToObjectWithRawMappings(body, context, {
      ...this.resourceBodyFragmentOptions(kind),
      allowBase: false
    });
  }

  private compileItemBody(
    body: ResourceDeclNode["body"],
    context: RsglCompileContext
  ): { content: Record<string, JsonValue>; mappings: RsglMapping[] } {
    if (body.kind !== "ResourceBody") {
      this.host.onError(
        "rsgl.invalidItemBody",
        "An item declaration requires a resource body.",
        body.range
      );
      return { content: {}, mappings: [] };
    }
    const compiled = executeItemResourceBody(body, context, this.itemOperationExecutorHost());
    return {
      content: compiled.content,
      mappings: compiled.mappings.map(mapping => ({
        ...this.host.sourceMapping(mapping.generatedPath, mapping.sourceRange, mapping.context),
        ...(mapping.validationOrigin ? { validationOrigin: mapping.validationOrigin } : {}),
        ...(mapping.validationOnly ? { validationOnly: true } : {})
      }))
    };
  }

  private itemOperationExecutorHost(): ItemOperationExecutorHost {
    return {
      ...this.jsonValueSinkOptions(),
      maxItemModelDepth: this.host.maxItemModelDepth ?? DEFAULT_MAX_ITEM_MODEL_DEPTH,
      resourceBodyOptions: this.resourceBodyFragmentOptions("item"),
      resolveTemplate: (expression, context) => this.host.findTemplateDefinition(expression, context),
      expandTemplate: (expression, context, definition) =>
        this.host.createTemplateExpansion(expression, context, definition),
      resolveTemplateDispatch: (definition, callerContext) =>
        this.host.resolveTemplateDispatch(definition, callerContext),
      onWarning: (code, message, range, fileName) =>
        this.host.onWarning(code, message, range, fileName)
    };
  }

  private jsonValueSinkOptions(): JsonValueSinkOptions {
    return {
      onError: (code, message, range, fileName) => this.host.onError(code, message, range, fileName),
      onInvalidJsonValue: () => this.host.onInvalidJsonValue(),
      onResourceValueObservation: observation => this.host.onResourceValueObservation(observation)
    };
  }

  private modelGeometryDslOptions(): ModelGeometryDslOptions {
    return {
      ...this.jsonValueSinkOptions(),
      compileModelBody: (body, context) => {
        const bodyContext = childEvaluationContext(context, {});
        const compiled = this.resourceBodyToObjectWithRawMappings(body, bodyContext, {
          ...this.resourceBodyFragmentOptions("model"),
          allowBase: false
        });
        return { content: compiled.content, mappings: compiled.mappings };
      }
    };
  }

  private resourceBodyFragmentOptions(
    kind: Exclude<RsglResourceKind, "blockstate">
  ): ResourceBodyCompileOptions {
    return {
      ...this.jsonValueSinkOptions(),
      onUseFragment: (useStatement, fragmentContext) => {
        const templateFragment = this.host.compileResourceBodyFragment(
          useStatement,
          fragmentContext,
          kind
        );
        if (templateFragment) {
          return templateFragment;
        }
        const calleeName = useStatement.expression.kind === "CallExpr"
          && useStatement.expression.callee.kind === "IdentifierExpr"
          ? useStatement.expression.callee.name.text
          : undefined;
        if (
          calleeName
          && (
            this.host.moduleValueBindingNames.has(calleeName)
            || hasEvaluationValueBinding(fragmentContext, calleeName)
          )
        ) {
          return undefined;
        }
        if (kind !== "model" && kind !== "item" && isJsonResourceFragmentKind(kind)) {
          return compileJsonResourceUseFragment(
            kind,
            useStatement,
            fragmentContext,
            this.jsonValueSinkOptions()
          );
        }
        return undefined;
      },
      onSpecialStatement: (statement, fragmentContext) => kind === "model"
        ? compileModelGeometryStatement(statement, fragmentContext, this.modelGeometryDslOptions())
        : undefined
    };
  }

  private jsonResourceFragmentOptions(kind: JsonResourceFragmentKind): ResourceBodyCompileOptions {
    const baseOptions = this.resourceBodyFragmentOptions(kind);
    if (kind !== "atlas" && kind !== "equipment") {
      return baseOptions;
    }
    return {
      ...baseOptions,
      onSpecialStatement: (statement, context) =>
        this.compileJsonResourceSpecialStatement(kind, statement, context)
        ?? baseOptions.onSpecialStatement?.(statement, context)
    };
  }

  private compileJsonResourceSpecialStatement(
    kind: JsonResourceFragmentKind,
    statement: ResourceStatementNode,
    context: RsglCompileContext
  ): ResourceBodySpecialResult | undefined {
    if (kind === "atlas") {
      return compileAtlasSpecialStatement(
        statement,
        context,
        (body, bodyContext) => this.resourceBodyToObjectWithRawMappings(
          body,
          bodyContext,
          {
            ...this.resourceBodyFragmentOptions("atlas"),
            allowBase: false,
            generatedPathPrefix: "/sources/0"
          }
        ),
        this.jsonValueSinkOptions()
      );
    }
    if (kind === "equipment" && statement.kind === "EquipmentLayerStmt") {
      return compileEquipmentLayerStatement(statement, context, this.jsonValueSinkOptions());
    }
    return undefined;
  }
}

function isJsonResourceFragmentKind(
  kind: Exclude<RsglResourceKind, "blockstate">
): kind is JsonResourceFragmentKind {
  return kind === "mcmeta" || isRsglGenericJsonResourceKind(kind);
}
