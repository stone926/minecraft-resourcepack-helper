import type { TextRange } from "../../parser";
import type { JsonValue } from "../ir";

/** A filesystem input that can invalidate a compiled RSGL program. */
export interface CompileDependency {
  /** Exact input path, or the static search root when globPattern is present. */
  path: string;
  reason: "base-import" | "copy" | "glob" | "extern";
  sourceFile: string;
  sourceRange: TextRange;
  /**
   * A slash-normalized pattern relative to path. Pattern dependencies let
   * watcher-backed hosts observe future matching creates and deletes without
   * watching the complete workspace.
   */
  globPattern?: string;
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
