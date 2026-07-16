import type { ExprNode, TextRange } from "../parser";
import type {
  RsglTemplateCallerContext,
  TemplateOutputDispatch
} from "../templateOutput";
import type { RsglTemplateDefinition } from "./environment";
import type { JsonValue } from "./ir";
import type { JsonValueSinkOptions } from "./jsonValueLowerer";
import type { ResourceBodyMapping } from "./resourceBody";
import type { RsglCompileContext, TemplateExpansion } from "./templateExpansion";

/** Compiler services required while lowering recursive item-model syntax. */
export interface ItemModelExecutorHost extends JsonValueSinkOptions {
  readonly maxItemModelDepth?: number;
  onWarning?: (code: string, message: string, range: TextRange, fileName?: string) => void;
  resolveTemplate(expression: ExprNode, context: RsglCompileContext): RsglTemplateDefinition | undefined;
  expandTemplate(
    expression: ExprNode,
    context: RsglCompileContext,
    definition: RsglTemplateDefinition
  ): TemplateExpansion | undefined;
  resolveTemplateDispatch(
    definition: RsglTemplateDefinition,
    callerContext: RsglTemplateCallerContext
  ): TemplateOutputDispatch;
}

/** One normalized item-model value and its source-to-output mappings. */
export interface LoweredItemModel {
  readonly value: Record<string, JsonValue>;
  readonly mappings: readonly ResourceBodyMapping[];
}

/** Internal mutable form used while attaching postfix options. */
export interface MutableItemModelLowering {
  value: Record<string, JsonValue>;
  mappings: ResourceBodyMapping[];
}
