import type {
  BaseStmtNode,
  BlockNode,
  BlockstateMode,
  BlockstateMultipartEntryNode,
  BlockstateMultipartRootBodyNode,
  BlockstateMultipartRootStatementNode,
  BlockstateVariantEntryNode,
  BlockstateVariantsRootBodyNode,
  BlockstateVariantsRootStatementNode,
  ForStmtNode,
  IfStmtNode,
  LegacyBlockstateRootBodyNode,
  LegacyBlockstateRootStatementNode,
  LetDeclNode,
  MergeStmtNode,
  MultipartBodyNode,
  MultipartEntryNode,
  MultipartSectionNode,
  PropertyStmtNode,
  ResourceBodyNode,
  ResourceStatementNode,
  TextRange,
  TopLevelStatementNode,
  UseDeclNode,
  VariantBodyNode,
  VariantEntryNode,
  VariantsSectionNode
} from "../parser";
import { inferStaticBlockstateMode } from "../blockstateModeEvidence";

export type BlockstateProgramMode = BlockstateMode | "neutral" | "conflict";
export type BlockstateProgramScope = "root" | "entries";

export interface BlockstateOperationProgram {
  readonly mode: BlockstateProgramMode;
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
  | BlockstateOperationBase<"VariantEntry", BlockstateVariantEntryNode | VariantEntryNode>
  | BlockstateOperationBase<"MultipartEntry", BlockstateMultipartEntryNode | MultipartEntryNode>
  | BlockstateOperationBase<"Unsupported", BlockstateStatement>
  | BlockstateForOperation
  | BlockstateIfOperation
  | BlockstateEntriesOperation;

export interface BlockstateForOperation extends BlockstateOperationBase<"For", ForStmtNode> {
  readonly body: BlockstateOperationProgram;
}

export interface BlockstateIfOperation extends BlockstateOperationBase<"If", IfStmtNode> {
  readonly thenProgram: BlockstateOperationProgram;
  readonly elseProgram?: BlockstateOperationProgram;
}

/** Legacy wrapper preserved as an ordered operation rather than a synthetic parser body. */
export interface BlockstateEntriesOperation
  extends BlockstateOperationBase<"Entries", VariantsSectionNode | MultipartSectionNode> {
  readonly mode: BlockstateMode;
  readonly body: BlockstateOperationProgram;
}

type BlockstateRootBody =
  | BlockstateVariantsRootBodyNode
  | BlockstateMultipartRootBodyNode
  | LegacyBlockstateRootBodyNode;

type BlockstateBody = BlockstateRootBody | BlockNode | ResourceBodyNode | VariantBodyNode | MultipartBodyNode;

type BlockstateStatement =
  | ResourceStatementNode
  | TopLevelStatementNode
  | BlockstateVariantsRootStatementNode
  | BlockstateMultipartRootStatementNode
  | LegacyBlockstateRootStatementNode;

export function canonicalBlockstateOperationProgram(
  body: BlockstateVariantsRootBodyNode | BlockstateMultipartRootBodyNode
): BlockstateOperationProgram {
  const mode = body.kind === "BlockstateVariantsRootBody" ? "variants" : "multipart";
  return programFromStatements(body.statements, mode, "root", body.range);
}

export function legacyBlockstateOperationProgram(
  body: LegacyBlockstateRootBodyNode
): BlockstateOperationProgram {
  return programFromStatements(body.statements, inferStatementsMode(body.statements), "root", body.range);
}

/** Converts a dispatched template body without evaluating parameters/defaults or statements. */
export function templateBlockstateOperationProgram(
  body: ResourceBodyNode | VariantBodyNode | MultipartBodyNode,
  mode: BlockstateMode,
  scope: BlockstateProgramScope
): BlockstateOperationProgram {
  if (body.kind === "VariantBody") {
    return programFromStatements(body.statements, "variants", "entries", body.range);
  }
  if (body.kind === "MultipartBody") {
    return programFromStatements(body.statements, "multipart", "entries", body.range);
  }
  return programFromStatements(body.statements, mode, scope, body.range);
}

/** First static mode evidence in source order; `conflict` means both modes are present. */
export function inferBlockstateProgramMode(program: BlockstateOperationProgram): BlockstateProgramMode {
  return inferOperationsMode(program.operations, program.mode);
}

function programFromBody(
  body: BlockstateBody,
  fallbackMode: BlockstateProgramMode,
  fallbackScope: BlockstateProgramScope
): BlockstateOperationProgram {
  if (body.kind === "VariantBody") {
    return programFromStatements(body.statements, "variants", "entries", body.range);
  }
  if (body.kind === "MultipartBody") {
    return programFromStatements(body.statements, "multipart", "entries", body.range);
  }
  if (body.kind === "BlockstateVariantsRootBody") {
    return programFromStatements(body.statements, "variants", "root", body.range);
  }
  if (body.kind === "BlockstateMultipartRootBody") {
    return programFromStatements(body.statements, "multipart", "root", body.range);
  }
  if (body.kind === "LegacyBlockstateRootBody") {
    return programFromStatements(body.statements, inferStatementsMode(body.statements), "root", body.range);
  }
  if (body.kind === "Block") {
    return programFromStatements(body.statements, fallbackMode, fallbackScope, body.range);
  }
  return programFromStatements(body.statements, fallbackMode, fallbackScope, body.range);
}

function programFromStatements(
  statements: readonly BlockstateStatement[],
  mode: BlockstateProgramMode,
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
  mode: BlockstateProgramMode,
  scope: BlockstateProgramScope
): BlockstateOperation {
  if (statement.kind === "LetDecl") {
    return { kind: "Let", statement, sourceIndex };
  }
  if (statement.kind === "UseDecl") {
    return { kind: "Use", statement, sourceIndex };
  }
  if (statement.kind === "BaseStmt") {
    return { kind: "Base", statement, sourceIndex };
  }
  if (statement.kind === "MergeStmt") {
    return { kind: "RootMerge", statement, sourceIndex };
  }
  if (statement.kind === "PropertyStmt") {
    return { kind: "RootProperty", statement, sourceIndex };
  }
  if (statement.kind === "BlockstateVariantEntry" || statement.kind === "VariantEntry") {
    return { kind: "VariantEntry", statement, sourceIndex };
  }
  if (statement.kind === "BlockstateMultipartEntry" || statement.kind === "MultipartEntry") {
    return { kind: "MultipartEntry", statement, sourceIndex };
  }
  if (statement.kind === "ForStmt") {
    return {
      kind: "For",
      statement,
      sourceIndex,
      body: programFromBody(statement.body, mode, scope)
    };
  }
  if (statement.kind === "IfStmt") {
    return {
      kind: "If",
      statement,
      sourceIndex,
      thenProgram: programFromBody(statement.thenBody, mode, scope),
      ...(statement.elseBody
        ? { elseProgram: programFromBody(statement.elseBody, mode, scope) }
        : {})
    };
  }
  if (statement.kind === "VariantsSection" || statement.kind === "MultipartSection") {
    const sectionMode = statement.kind === "VariantsSection" ? "variants" : "multipart";
    return {
      kind: "Entries",
      statement,
      sourceIndex,
      mode: sectionMode,
      body: programFromStatements(statement.entries, sectionMode, "entries", statement.range)
    };
  }
  return { kind: "Unsupported", statement, sourceIndex };
}

function inferStatementsMode(statements: readonly BlockstateStatement[]): BlockstateProgramMode {
  return inferOperationsMode(
    statements.map((statement, sourceIndex) => operationFromStatement(statement, sourceIndex, "neutral", "root")),
    "neutral"
  );
}

function inferOperationsMode(
  operations: readonly BlockstateOperation[],
  initial: BlockstateProgramMode
): BlockstateProgramMode {
  let result = initial;
  for (const operation of operations) {
    let evidence: BlockstateProgramMode = "neutral";
    if (operation.kind === "VariantEntry") {
      evidence = "variants";
    } else if (operation.kind === "MultipartEntry") {
      evidence = "multipart";
    } else if (operation.kind === "Entries") {
      evidence = operation.mode;
    } else if (operation.kind === "For") {
      evidence = inferBlockstateProgramMode(operation.body);
    } else if (operation.kind === "If") {
      evidence = combineModes(
        inferBlockstateProgramMode(operation.thenProgram),
        operation.elseProgram ? inferBlockstateProgramMode(operation.elseProgram) : "neutral"
      );
    } else if (operation.kind === "RootMerge") {
      evidence = inferStaticBlockstateMode(operation.statement.value);
    }
    result = combineModes(result, evidence);
    if (result === "conflict") {
      return result;
    }
  }
  return result;
}

function combineModes(left: BlockstateProgramMode, right: BlockstateProgramMode): BlockstateProgramMode {
  if (left === "conflict" || right === "conflict") {
    return "conflict";
  }
  if (left === "neutral") {
    return right;
  }
  if (right === "neutral" || left === right) {
    return left;
  }
  return "conflict";
}
