import type { TextRange } from "../../parser";
import type { JsonValue } from "../ir";

/** A filesystem input that can invalidate a compiled RSGL program. */
export interface CompileDependency {
  path: string;
  reason: "base-import" | "glob" | "extern";
  sourceFile: string;
  sourceRange: TextRange;
}

/** Parsed JSON content and source locations for one imported base document. */
export interface BaseDocument {
  content: JsonValue;
  sourceFile: string;
  sourceRange: TextRange;
  sourceRanges: ReadonlyMap<string, TextRange>;
  dependencies: CompileDependency[];
}

/** Synchronous loader seam used by the compiler, LSP, and tests. */
export interface BaseDocumentLoader {
  load(path: string, sourceFile: string, sourceRange: TextRange): BaseDocument;
}

export type BaseDocumentLoadErrorCode =
  | "rsgl.baseLoadFailed"
  | "rsgl.baseParseFailed";

/** A typed loader failure that the statement compiler can turn into a diagnostic. */
export class BaseDocumentLoadError extends Error {
  public constructor(
    public readonly code: BaseDocumentLoadErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "BaseDocumentLoadError";
  }
}
