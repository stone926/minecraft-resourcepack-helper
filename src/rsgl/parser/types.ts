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
  statements: TopLevelStatementNode[];
  eof: RsglToken;
  diagnostics: RsglDiagnostic[];
  tokens: RsglToken[];
}

export type TopLevelStatementNode =
  | TargetDeclNode
  | NamespaceDeclNode
  | ImportDeclNode
  | ExportDeclNode
  | LetDeclNode
  | TableDeclNode
  | TemplateDeclNode
  | FragmentDeclNode
  | ResourceDeclNode
  | SugarDeclNode
  | OverlayDeclNode
  | UseDeclNode
  | ForStmtNode
  | IfStmtNode
  | UnknownStmtNode;

export type RsglStatement = TopLevelStatementNode | ResourceStatementNode;

export interface StatementNodeBase extends RsglNode {
  kind: string;
  keyword: string;
}

export interface IdentifierNode extends RsglNode {
  kind: "Identifier";
  text: string;
}

export interface StringLiteralNode extends RsglNode {
  kind: "StringLiteral";
  value: string;
  raw: string;
}

export interface NumberLiteralNode extends RsglNode {
  kind: "NumberLiteral";
  value: number;
  raw: string;
}

export interface BooleanLiteralNode extends RsglNode {
  kind: "BooleanLiteral";
  value: boolean;
}

export interface NullLiteralNode extends RsglNode {
  kind: "NullLiteral";
}

export interface ResourceLocationExprNode extends RsglNode {
  kind: "ResourceLocationExpr";
  value: string;
}

export interface IdentifierExprNode extends RsglNode {
  kind: "IdentifierExpr";
  name: IdentifierNode;
}

export interface MissingExprNode extends RsglNode {
  kind: "MissingExpr";
}

export interface TemplateStringExprNode extends RsglNode {
  kind: "TemplateStringExpr";
  raw: string;
  parts: TemplateStringPart[];
}

export type TemplateStringPart =
  | { kind: "text"; text: string; range: TextRange }
  | { kind: "expression"; expression: ExprNode; range: TextRange };

export interface ListExprNode extends RsglNode {
  kind: "ListExpr";
  elements: ExprNode[];
}

export interface ObjectExprNode extends RsglNode {
  kind: "ObjectExpr";
  properties: ObjectPropertyNode[];
}

export interface ObjectPropertyNode extends RsglNode {
  kind: "ObjectProperty";
  key: IdentifierNode | StringLiteralNode | DynamicKeyNode;
  value: ExprNode;
}

export interface DynamicKeyNode extends RsglNode {
  kind: "DynamicKey";
  expression: ExprNode;
}

export interface RangeExprNode extends RsglNode {
  kind: "RangeExpr";
  startExpr: ExprNode;
  endExpr: ExprNode;
  inclusive: true;
}

export interface CallExprNode extends RsglNode {
  kind: "CallExpr";
  callee: ExprNode;
  args: ArgumentNode[];
}

export interface ArgumentNode extends RsglNode {
  kind: "Argument";
  name?: IdentifierNode;
  value: ExprNode;
}

export interface MemberExprNode extends RsglNode {
  kind: "MemberExpr";
  object: ExprNode;
  property: IdentifierNode;
}

export interface IndexExprNode extends RsglNode {
  kind: "IndexExpr";
  object: ExprNode;
  index: ExprNode;
}

export interface UnaryExprNode extends RsglNode {
  kind: "UnaryExpr";
  operator: string;
  operand: ExprNode;
}

export interface BinaryExprNode extends RsglNode {
  kind: "BinaryExpr";
  operator: string;
  left: ExprNode;
  right: ExprNode;
}

export interface ConditionalExprNode extends RsglNode {
  kind: "ConditionalExpr";
  condition: ExprNode;
  whenTrue: ExprNode;
  whenFalse: ExprNode;
}

export interface MatchExprNode extends RsglNode {
  kind: "MatchExpr";
  expression: ExprNode;
  arms: MatchArmNode[];
}

export interface MatchArmNode extends RsglNode {
  kind: "MatchArm";
  patterns: ExprNode[];
  value: ExprNode;
}

export interface StateKeySugarNode extends RsglNode {
  kind: "StateKeySugar";
  entries: ObjectPropertyNode[];
}

export interface ModelApplySugarNode extends RsglNode {
  kind: "ModelApplySugar";
  model: ExprNode;
  properties: SugarPropertyNode[];
}

export interface SugarPropertyNode extends RsglNode {
  kind: "SugarProperty";
  name: IdentifierNode;
  value: ExprNode;
}

export interface RandomApplyNode extends RsglNode {
  kind: "RandomApply";
  entries: ExprNode[];
}

export type ExprNode =
  | IdentifierExprNode
  | StringLiteralNode
  | NumberLiteralNode
  | BooleanLiteralNode
  | NullLiteralNode
  | ResourceLocationExprNode
  | TemplateStringExprNode
  | ListExprNode
  | ObjectExprNode
  | RangeExprNode
  | CallExprNode
  | MemberExprNode
  | IndexExprNode
  | UnaryExprNode
  | BinaryExprNode
  | ConditionalExprNode
  | MatchExprNode
  | StateKeySugarNode
  | ModelApplySugarNode
  | RandomApplyNode
  | MissingExprNode;

export type TypeNode = NamedTypeNode | GenericTypeNode | UnionTypeNode | LiteralTypeNode | MissingTypeNode;

export interface NamedTypeNode extends RsglNode {
  kind: "NamedType";
  name: IdentifierNode;
}

export interface GenericTypeNode extends RsglNode {
  kind: "GenericType";
  name: IdentifierNode;
  args: TypeNode[];
}

export interface UnionTypeNode extends RsglNode {
  kind: "UnionType";
  options: TypeNode[];
}

export interface LiteralTypeNode extends RsglNode {
  kind: "LiteralType";
  value: StringLiteralNode | NumberLiteralNode | BooleanLiteralNode | NullLiteralNode;
}

export interface MissingTypeNode extends RsglNode {
  kind: "MissingType";
}

export interface BlockNode extends RsglNode {
  kind: "Block";
  statements: TopLevelStatementNode[];
}

export interface ResourceBodyNode extends RsglNode {
  kind: "ResourceBody";
  statements: ResourceStatementNode[];
}

export interface VariantBodyNode extends RsglNode {
  kind: "VariantBody";
  statements: VariantSectionStatementNode[];
}

export interface MultipartBodyNode extends RsglNode {
  kind: "MultipartBody";
  statements: MultipartSectionStatementNode[];
}

export interface TargetDeclNode extends StatementNodeBase {
  kind: "TargetDecl";
  edition: IdentifierNode | null;
  selector: "format" | "mc" | null;
  value: ExprNode;
}

export interface OverlayDeclNode extends StatementNodeBase {
  kind: "OverlayDecl";
  directory: ExprNode;
  formatRange?: ExprNode;
  body: BlockNode;
}

export interface NamespaceDeclNode extends StatementNodeBase {
  kind: "NamespaceDecl";
  name: ExprNode;
}

export interface ImportSpecifierNode extends RsglNode {
  kind: "ImportSpecifier";
  imported: IdentifierNode;
  local: IdentifierNode;
}

export interface ImportDeclNode extends StatementNodeBase {
  kind: "ImportDecl";
  defaultName?: IdentifierNode;
  namedImports: ImportSpecifierNode[];
  source: StringLiteralNode | null;
}

export interface ExportSpecifierNode extends RsglNode {
  kind: "ExportSpecifier";
  local: IdentifierNode;
  exported: IdentifierNode;
}

export interface ExportDeclNode extends StatementNodeBase {
  kind: "ExportDecl";
  specifiers: ExportSpecifierNode[];
  source: StringLiteralNode | null;
  exportAll: boolean;
}

export interface LetDeclNode extends StatementNodeBase {
  kind: "LetDecl";
  name: IdentifierNode | null;
  typeAnnotation?: TypeNode;
  value: ExprNode;
}

export interface TableDeclNode extends StatementNodeBase {
  kind: "TableDecl";
  name: IdentifierNode | null;
  body: ObjectExprNode;
}

export interface ParameterNode extends RsglNode {
  kind: "Parameter";
  name: IdentifierNode | null;
  typeAnnotation?: TypeNode;
  defaultValue?: ExprNode;
}

export interface TemplateDeclNode extends StatementNodeBase {
  kind: "TemplateDecl";
  name: IdentifierNode | null;
  parameters: ParameterNode[];
  body: BlockNode;
}

export interface FragmentDeclNode extends StatementNodeBase {
  kind: "FragmentDecl";
  name: IdentifierNode | null;
  parameters: ParameterNode[];
  body: ResourceBodyNode;
}

export type ResourceKind =
  | "model"
  | "blockstate"
  | "item"
  | "atlas"
  | "mcmeta"
  | "particles"
  | "equipment"
  | "font"
  | "pack"
  | "lang"
  | "sounds";

export interface ResourceDeclNode extends StatementNodeBase {
  kind: "ResourceDecl";
  resourceKind: ResourceKind;
  subtype?: IdentifierNode;
  id?: ExprNode;
  body: ResourceBodyNode;
}

export type SugarKind =
  | "conventionalBlockstate"
  | "batchModel"
  | "batchItemModel"
  | "family";

export interface SugarDeclNode extends StatementNodeBase {
  kind: "SugarDecl";
  sugarKind: SugarKind;
  sugarName: IdentifierNode;
  id?: ExprNode;
  entries: SugarEntryNode[];
  options: SugarOptionNode[];
  body?: ResourceBodyNode;
}

export interface SugarEntryNode extends RsglNode {
  kind: "SugarEntry";
  id: ExprNode;
  target?: ExprNode;
}

export interface SugarOptionNode extends RsglNode {
  kind: "SugarOption";
  name: IdentifierNode;
  value?: ExprNode;
}

export interface UseDeclNode extends StatementNodeBase {
  kind: "UseDecl";
  expression: ExprNode;
}

export interface ForStmtNode extends StatementNodeBase {
  kind: "ForStmt";
  bindings: IdentifierNode[];
  iterable: ExprNode;
  body: BlockNode | ResourceBodyNode | VariantBodyNode | MultipartBodyNode;
}

export interface IfStmtNode extends StatementNodeBase {
  kind: "IfStmt";
  condition: ExprNode;
  thenBody: BlockNode | ResourceBodyNode | VariantBodyNode | MultipartBodyNode;
  elseBody?: BlockNode | ResourceBodyNode | VariantBodyNode | MultipartBodyNode;
}

export interface UnknownStmtNode extends StatementNodeBase {
  kind: "UnknownStmt";
}

export type ResourceStatementNode =
  | PropertyStmtNode
  | SectionStmtNode
  | VariantsSectionNode
  | MultipartSectionNode
  | ItemRangeStmtNode
  | ItemSelectStmtNode
  | ItemConditionStmtNode
  | ItemCompositeStmtNode
  | ItemEmptyStmtNode
  | ItemSelectedItemStmtNode
  | ItemSpecialStmtNode
  | VariantEntryNode
  | MultipartEntryNode
  | UseDeclNode
  | ForStmtNode
  | IfStmtNode
  | RawJsonStmtNode
  | OverrideStmtNode
  | AppendStmtNode
  | UnknownStmtNode;

export interface PropertyStmtNode extends StatementNodeBase {
  kind: "PropertyStmt";
  name: IdentifierNode;
  value: ExprNode;
}

export interface SectionStmtNode extends StatementNodeBase {
  kind: "SectionStmt";
  name: IdentifierNode;
  body?: ResourceBodyNode;
  value?: ExprNode;
}

export interface VariantsSectionNode extends StatementNodeBase {
  kind: "VariantsSection";
  entries: VariantSectionStatementNode[];
}

export interface VariantEntryNode extends StatementNodeBase {
  kind: "VariantEntry";
  state: ExprNode;
  value: ExprNode;
}

export type VariantSectionStatementNode = VariantEntryNode | UseDeclNode | ForStmtNode | IfStmtNode | UnknownStmtNode;

export interface MultipartSectionNode extends StatementNodeBase {
  kind: "MultipartSection";
  entries: MultipartSectionStatementNode[];
}

export interface MultipartEntryNode extends StatementNodeBase {
  kind: "MultipartEntry";
  when?: ExprNode;
  apply: ExprNode;
}

export type MultipartSectionStatementNode = MultipartEntryNode | UseDeclNode | ForStmtNode | IfStmtNode | UnknownStmtNode;

export interface ItemOptionNode extends RsglNode {
  kind: "ItemOption";
  name: IdentifierNode;
  value: ExprNode;
}

export interface ItemRangeFramesNode extends RsglNode {
  kind: "ItemRangeFrames";
  frames: ExprNode;
  model: ExprNode;
}

export interface ItemRangeStmtNode extends StatementNodeBase {
  kind: "ItemRangeStmt";
  property: ExprNode;
  options: ItemOptionNode[];
  frames?: ItemRangeFramesNode;
  fallback?: ExprNode;
}

export interface ItemSelectCaseNode extends RsglNode {
  kind: "ItemSelectCase";
  when: ExprNode;
  model: ExprNode;
}

export interface ItemSelectStmtNode extends StatementNodeBase {
  kind: "ItemSelectStmt";
  property: ExprNode;
  options: ItemOptionNode[];
  cases: ItemSelectCaseNode[];
  fallback?: ExprNode;
}

export interface ItemConditionStmtNode extends StatementNodeBase {
  kind: "ItemConditionStmt";
  property: ExprNode;
  options: ItemOptionNode[];
  onTrue?: ExprNode;
  onFalse?: ExprNode;
}

export interface ItemCompositeStmtNode extends StatementNodeBase {
  kind: "ItemCompositeStmt";
  models: ExprNode[];
}

export interface ItemEmptyStmtNode extends StatementNodeBase {
  kind: "ItemEmptyStmt";
}

export interface ItemSelectedItemStmtNode extends StatementNodeBase {
  kind: "ItemSelectedItemStmt";
}

export interface ItemSpecialStmtNode extends StatementNodeBase {
  kind: "ItemSpecialStmt";
  base: ExprNode;
  model: ExprNode;
}

export interface RawJsonStmtNode extends StatementNodeBase {
  kind: "RawJsonStmt";
  value: ExprNode;
}

export interface OverrideStmtNode extends StatementNodeBase {
  kind: "OverrideStmt";
  value: ExprNode;
}

export interface AppendStmtNode extends StatementNodeBase {
  kind: "AppendStmt";
  value: ExprNode;
}

export interface LexResult {
  tokens: RsglToken[];
  diagnostics: RsglDiagnostic[];
}
