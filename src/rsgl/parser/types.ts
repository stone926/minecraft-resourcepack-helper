export type RsglTokenKind =
  | "identifier"
  | "keyword"
  | "resourceLocation"
  | "string"
  | "templateString"
  | "number"
  | "operator"
  | "punctuation"
  | "invalid"
  | "endOfFile";

export interface TextRange {
  start: number;
  end: number;
}

export interface Trivia {
  kind: "whitespace" | "lineComment" | "blockComment" | "newline";
  text: string;
  offset: number;
  length: number;
}

export interface RsglToken {
  kind: RsglTokenKind;
  text: string;
  offset: number;
  length: number;
  leadingTrivia: Trivia[];
}

export type RsglDiagnosticSeverity = "error" | "warning" | "info";

export interface RsglDiagnostic {
  code: string;
  message: string;
  severity: RsglDiagnosticSeverity;
  range: TextRange;
}

export interface RsglNode {
  kind: string;
  range: TextRange;
  fullRange: TextRange;
}

export interface RsglModule extends RsglNode {
  kind: "Module";
  statements: RsglStatement[];
  eof: RsglToken;
  diagnostics: RsglDiagnostic[];
  tokens: RsglToken[];
}

export interface RsglStatement extends RsglNode {
  kind:
    | "TargetDecl"
    | "NamespaceDecl"
    | "ImportDecl"
    | "LetDecl"
    | "TableDecl"
    | "TemplateDecl"
    | "ResourceDecl"
    | "SugarDecl"
    | "UseDecl"
    | "ForStmt"
    | "IfStmt"
    | "UnknownStmt";
  keyword: string;
}

export interface LexResult {
  tokens: RsglToken[];
  diagnostics: RsglDiagnostic[];
}
