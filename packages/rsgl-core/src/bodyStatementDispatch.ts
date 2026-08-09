import type {
  ForStmtNode,
  IfStmtNode,
  LetDeclNode,
  RsglStatement,
  UnknownStmtNode
} from "./parser";

/** Statement scaffold shared by typed bodies that otherwise own distinct entries. */
export type RsglBodyScaffoldStatement =
  | LetDeclNode
  | ForStmtNode
  | IfStmtNode
  | UnknownStmtNode;

/** Domain-specific entries left after the shared body scaffold is removed. */
export type RsglBodyEntryStatement<TStatement extends RsglStatement> = Exclude<
  TStatement,
  RsglBodyScaffoldStatement
>;

export interface RsglBodyStatementHandlers<
  TStatement extends RsglStatement,
  TContext
> {
  readonly context: TContext;
  readonly onEntry: (
    statement: RsglBodyEntryStatement<TStatement>,
    context: TContext
  ) => void;
  readonly onLet: (statement: LetDeclNode, context: TContext) => void;
  readonly onFor: (statement: ForStmtNode, context: TContext) => void;
  readonly onIf: (statement: IfStmtNode, context: TContext) => void;
}

/**
 * Dispatches the common let/control-flow/recovery scaffold once while keeping
 * each typed body responsible for an exhaustive switch over its own entries.
 */
export function forEachBodyStatement<
  TStatement extends RsglStatement,
  TContext
>(
  statements: readonly TStatement[],
  handlers: RsglBodyStatementHandlers<TStatement, TContext>
): void {
  for (const statement of statements) {
    const current: RsglStatement = statement;
    switch (current.kind) {
      case "LetDecl":
        handlers.onLet(current, handlers.context);
        break;
      case "ForStmt":
        handlers.onFor(current, handlers.context);
        break;
      case "IfStmt":
        handlers.onIf(current, handlers.context);
        break;
      case "UnknownStmt":
        break;
      default:
        handlers.onEntry(
          current as RsglBodyEntryStatement<TStatement>,
          handlers.context
        );
    }
  }
}
