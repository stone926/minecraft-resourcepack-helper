import type {
  BaseStmtNode,
  BlockstateMode,
  BlockstateMultipartEntryNode,
  BlockstateMultipartRootBodyNode,
  BlockstateMultipartRootStatementNode,
  BlockstateVariantEntryNode,
  BlockstateVariantsRootBodyNode,
  BlockstateVariantsRootStatementNode,
  ForStmtNode,
  IfStmtNode,
  LetDeclNode,
  MergeStmtNode,
  MultipartBodyNode,
  MultipartSectionStatementNode,
  PropertyStmtNode,
  TextRange,
  UseDeclNode,
  VariantBodyNode,
  VariantSectionStatementNode
} from "../parser";

export type BlockstateProgramScope = "root" | "entries";

export interface BlockstateOperationProgram {
  readonly mode: BlockstateMode;
  readonly scope: BlockstateProgramScope;
  readonly range: TextRange;
  readonly operations: readonly BlockstateOperation[];
}

interface BlockstateOperationBase<TKind extends string, TStatement> {
  readonly kind: TKind;
  readonly statement: TStatement;
  /** Index in the source body; base validation relies on this rather than filtered operation order. */
  readonly sourceIndex: number;
}

export type BlockstateOperation =
  | BlockstateOperationBase<"Let", LetDeclNode>
  | BlockstateOperationBase<"Use", UseDeclNode>
  | BlockstateOperationBase<"Base", BaseStmtNode>
  | BlockstateOperationBase<"RootMerge", MergeStmtNode>
  | BlockstateOperationBase<"RootProperty", PropertyStmtNode>
  | BlockstateOperationBase<"VariantEntry", BlockstateVariantEntryNode>
  | BlockstateOperationBase<"MultipartEntry", BlockstateMultipartEntryNode>
  | BlockstateOperationBase<"Unsupported", BlockstateStatement>
  | BlockstateForOperation
  | BlockstateIfOperation;

export interface BlockstateForOperation extends BlockstateOperationBase<"For", ForStmtNode> {
  readonly body: BlockstateOperationProgram;
}

export interface BlockstateIfOperation extends BlockstateOperationBase<"If", IfStmtNode> {
  readonly thenProgram: BlockstateOperationProgram;
  readonly elseProgram?: BlockstateOperationProgram;
}

type BlockstateStatement =
  | BlockstateVariantsRootStatementNode
  | BlockstateMultipartRootStatementNode
  | VariantSectionStatementNode
  | MultipartSectionStatementNode;

export function canonicalBlockstateOperationProgram(
  body: BlockstateVariantsRootBodyNode | BlockstateMultipartRootBodyNode
): BlockstateOperationProgram {
  const mode = body.kind === "BlockstateVariantsRootBody" ? "variants" : "multipart";
  return programFromStatements(body.statements, mode, "root", body.range);
}

/** Converts an explicitly dispatched blockstate template body into operations. */
export function templateBlockstateOperationProgram(
  body: VariantBodyNode | MultipartBodyNode
): BlockstateOperationProgram {
  const mode = body.kind === "VariantBody" ? "variants" : "multipart";
  return programFromStatements(body.statements, mode, "entries", body.range);
}

function programFromBody(
  body: ForStmtNode["body"] | IfStmtNode["thenBody"],
  fallbackMode: BlockstateMode,
  fallbackScope: BlockstateProgramScope
): BlockstateOperationProgram {
  if (
    body.kind === "VariantBody"
    || body.kind === "MultipartBody"
    || body.kind === "BlockstateVariantsRootBody"
    || body.kind === "BlockstateMultipartRootBody"
  ) {
    const mode = body.kind === "VariantBody" || body.kind === "BlockstateVariantsRootBody"
      ? "variants"
      : "multipart";
    const scope = body.kind === "VariantBody" || body.kind === "MultipartBody"
      ? "entries"
      : "root";
    return programFromStatements(body.statements, mode, scope, body.range);
  }

  // Parser recovery may attach a non-blockstate body after a syntax error.
  // It is deliberately non-executable after a syntax error.
  return programFromStatements([], fallbackMode, fallbackScope, body.range);
}

function programFromStatements(
  statements: readonly BlockstateStatement[],
  mode: BlockstateMode,
  scope: BlockstateProgramScope,
  range: TextRange
): BlockstateOperationProgram {
  return {
    mode,
    scope,
    range,
    operations: statements.map((statement, sourceIndex) => operationFromStatement(
      statement,
      sourceIndex,
      mode,
      scope
    ))
  };
}

function operationFromStatement(
  statement: BlockstateStatement,
  sourceIndex: number,
  mode: BlockstateMode,
  scope: BlockstateProgramScope
): BlockstateOperation {
  switch (statement.kind) {
    case "LetDecl":
      return { kind: "Let", statement, sourceIndex };
    case "UseDecl":
      return { kind: "Use", statement, sourceIndex };
    case "BaseStmt":
      return { kind: "Base", statement, sourceIndex };
    case "MergeStmt":
      return { kind: "RootMerge", statement, sourceIndex };
    case "PropertyStmt":
      return { kind: "RootProperty", statement, sourceIndex };
    case "BlockstateVariantEntry":
      return { kind: "VariantEntry", statement, sourceIndex };
    case "BlockstateMultipartEntry":
      return { kind: "MultipartEntry", statement, sourceIndex };
    case "ForStmt":
      return {
        kind: "For",
        statement,
        sourceIndex,
        body: programFromBody(statement.body, mode, scope)
      };
    case "IfStmt":
      return {
        kind: "If",
        statement,
        sourceIndex,
        thenProgram: programFromBody(statement.thenBody, mode, scope),
        ...(statement.elseBody
          ? { elseProgram: programFromBody(statement.elseBody, mode, scope) }
          : {})
      };
    default:
      return { kind: "Unsupported", statement, sourceIndex };
  }
}
