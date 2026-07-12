import {
  BooleanLiteralNode,
  ExprNode,
  ForStmtNode,
  IdentifierNode,
  IfStmtNode,
  LetDeclNode,
  ObjectExprNode,
  ResourceBodyNode,
  RsglDiagnostic,
  RsglNode,
  RsglToken,
  StringLiteralNode,
  TextRange,
  UseDeclNode
} from "./types";

export interface StatementExpressionOptions {
  stopTexts?: readonly string[];
}

/** Narrow facade exposed to cohesive resource-statement parser modules. */
export interface ResourceStatementParserHost {
  current(): RsglToken;
  advance(): RsglToken;
  previousOr(fallback: RsglToken): RsglToken;
  isAtEnd(): boolean;
  isLineBoundaryOr(...texts: string[]): boolean;
  peekText(ahead: number): string;
  mark(): number;
  ensureProgress(mark: number, message: string): void;
  matchText(text: string): boolean;
  expectText(text: string, message: string): boolean;
  consumeOptionalSeparator(): void;
  consumeBalancedBlock(message: string): void;
  recoverToLineEnd(): void;
  addDiagnosticAtCurrent(code: string, message: string, severity?: RsglDiagnostic["severity"]): void;
  addDiagnostic(code: string, message: string, range: TextRange, severity?: RsglDiagnostic["severity"]): void;
  parseExpression(options?: StatementExpressionOptions, minPrecedence?: number): ExprNode;
  parseIdentifier(message: string): IdentifierNode | null;
  parseStringLiteral(): StringLiteralNode;
  parseObjectExpression(): ObjectExprNode;
  parseBlockstateEntryValue(): ExprNode;
  parseLetDecl(): LetDeclNode;
  parseUseDecl(): UseDeclNode;
  parseForStmt(mode: "resource" | "variants" | "multipart"): ForStmtNode;
  parseIfStmt(mode: "resource" | "variants" | "multipart"): IfStmtNode;
  parseResourceBody(owner: string, allowBase?: boolean): ResourceBodyNode;
  emptyResourceBodyAt(token: RsglToken, message: string): ResourceBodyNode;
  missingExprAt(token: RsglToken | RsglNode): ExprNode;
  syntheticIdentifier(token: RsglToken | RsglNode, text: string): IdentifierNode;
  booleanLiteral(token: RsglToken, value: boolean): BooleanLiteralNode;
  nodeRanges(start: RsglToken, end: RsglToken): Pick<RsglNode, "range" | "fullRange">;
}
