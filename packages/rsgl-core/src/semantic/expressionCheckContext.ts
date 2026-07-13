import type {
  CallExprNode,
  IdentifierNode,
  RsglDiagnostic,
  RsglNode
} from "../parser";
import type {
  RsglReferenceRecord,
  RsglScope,
  RsglSymbol,
  RsglType
} from "./types";

export interface RsglExpressionCheckContext {
  readonly diagnostics: RsglDiagnostic[];
  readonly references: RsglReferenceRecord[];
  defineIdentifier(
    scope: RsglScope,
    identifier: IdentifierNode | null | undefined,
    kind: RsglSymbol["kind"],
    type: RsglType,
    node: RsglNode
  ): void;
  /** Called for known imports and unresolved calls that may become bare import-all bindings. */
  recordImportCallScope?(expression: CallExprNode, scope: RsglScope): void;
  /** Suppresses cascaded undefined-symbol noise for rejected syntax with its own primary diagnostic. */
  isUndefinedSymbolDiagnosticSuppressed?(name: string): boolean;
}
