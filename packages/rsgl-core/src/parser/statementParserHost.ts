import {
  BooleanLiteralNode,
  BlockstateRootCommonStatementNode,
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
import type {
  BlockstateRootParseContext,
  BodyParseContext,
  ResourceBodyParseContext
} from "./bodyParseContext";
import type { RsglArrowExpectation } from "./arrowSemantics";

export interface StatementExpressionOptions {
  stopTexts?: readonly string[];
  allowLeadingLineBreak?: boolean;
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
  expectMappingArrow(context: string): RsglArrowExpectation;
  consumeOptionalSeparator(): void;
  consumeBalancedBlock(message: string): void;
  consumeBalancedEnclosure(openText: string, closeText: string, message: string): void;
  recoverToLineEnd(): void;
  addDiagnosticAtCurrent(code: string, message: string, severity?: RsglDiagnostic["severity"]): void;
  addDiagnostic(code: string, message: string, range: TextRange, severity?: RsglDiagnostic["severity"]): void;
  parseExpression(options?: StatementExpressionOptions, minPrecedence?: number): ExprNode;
  parseIdentifier(message: string): IdentifierNode | null;
  parseStringLiteral(): StringLiteralNode;
  parseObjectExpression(): ObjectExprNode;
  parseBlockstateRootCommonStatement(context: BlockstateRootParseContext): BlockstateRootCommonStatementNode;
  parseLetDecl(): LetDeclNode;
  parseUseDecl(): UseDeclNode;
  parseForStmt(context: BodyParseContext): ForStmtNode;
  parseIfStmt(context: BodyParseContext): IfStmtNode;
  parseResourceBody(context: ResourceBodyParseContext): ResourceBodyNode;
  emptyResourceBodyAt(token: RsglToken, message: string): ResourceBodyNode;
  missingExprAt(token: RsglToken | RsglNode): ExprNode;
  syntheticIdentifier(token: RsglToken | RsglNode, text: string): IdentifierNode;
  booleanLiteral(token: RsglToken, value: boolean): BooleanLiteralNode;
  nodeRanges(start: RsglToken, end: RsglToken): Pick<RsglNode, "range" | "fullRange">;
}
