import type { ExprNode } from "../parser";
import {
  lowerBlockstateStateRecord,
  type BlockstateStateRecordLoweringHost
} from "./blockstateStateRecordLowerer";
import { blockstateVariantKey } from "./blockstateKeys";
import type { EvaluationOrigin } from "./evaluate";
import type { JsonValue } from "./ir";
import type { RsglCompileContext } from "./templateExpansion";

export type BlockstateSelectorLoweringHost = BlockstateStateRecordLoweringHost;

export interface LoweredBlockstateSelector {
  readonly key: string;
  readonly value: Record<string, JsonValue>;
  readonly origin?: EvaluationOrigin;
}

/** Evaluates and canonicalizes a variants selector exactly once. */
export function lowerBlockstateSelector(
  expression: ExprNode,
  context: RsglCompileContext,
  host: BlockstateSelectorLoweringHost
): LoweredBlockstateSelector | undefined {
  const record = lowerBlockstateStateRecord(expression, context, host, "selector");
  if (!record) {
    return undefined;
  }
  return {
    key: blockstateVariantKey(record.value),
    value: record.value,
    ...(record.origin ? { origin: record.origin } : {})
  };
}
