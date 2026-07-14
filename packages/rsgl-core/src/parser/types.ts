import type { RsglResourceKind } from "../resourceKinds";
import type { ExternResourceSource } from "../externDeclarations";
export type { ExternResourceKind } from "../resourceKinds";
export type { ExternResourceSource } from "../externDeclarations";

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
  | ExternDeclNode
  | TypeAliasDeclNode
  | LetDeclNode
  | TableDeclNode
  | TemplateDeclNode
  | ResourceDeclNode
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
  elements: ListElementNode[];
}

export type ListElementNode = ExprNode | ListSpreadNode;

export interface ListSpreadNode extends RsglNode {
  kind: "ListSpread";
  expression: ExprNode;
}

export interface ObjectExprNode extends RsglNode {
  kind: "ObjectExpr";
  properties: ObjectEntryNode[];
}

export type ObjectEntryNode = ObjectPropertyNode | ObjectSpreadNode;

export interface ObjectPropertyNode extends RsglNode {
  kind: "ObjectProperty";
  key: IdentifierNode | StringLiteralNode | NumberLiteralNode | DynamicKeyNode;
  value: ExprNode;
}

export interface ObjectSpreadNode extends RsglNode {
  kind: "ObjectSpread";
  expression: ExprNode;
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

export interface LambdaExprNode extends RsglNode {
  kind: "LambdaExpr";
  parameters: IdentifierNode[];
  body: ExprNode;
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

export interface ForInExprNode extends RsglNode {
  kind: "ForInExpr";
  binding: IdentifierNode;
  iterable: ExprNode;
}

/**
 * Compatibility-only selector syntax for legacy `[key=value]` blockstate
 * entries. Canonical blockstate selectors use ObjectExpr + DynamicKeyNode.
 *
 * Kept in ExprNode during the migration window so existing semantic/compiler
 * adapters can continue to consume old source without parser AST rewriting.
 */
export interface StateKeySugarNode extends RsglNode {
  kind: "StateKeySugar";
  entries: ObjectPropertyNode[];
}

/** Compatibility-only `@model` blockstate apply syntax. */
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
  | LambdaExprNode
  | MatchExprNode
  | ForInExprNode
  | StateKeySugarNode
  | ModelApplySugarNode
  | RandomApplyNode
  | MissingExprNode;

export type TypeNode =
  | NamedTypeNode
  | GenericTypeNode
  | FunctionTypeNode
  | UnionTypeNode
  | ObjectTypeNode
  | LiteralTypeNode
  | MissingTypeNode;

export interface NamedTypeNode extends RsglNode {
  kind: "NamedType";
  name: IdentifierNode;
}

export interface GenericTypeNode extends RsglNode {
  kind: "GenericType";
  name: IdentifierNode;
  args: TypeNode[];
}

export interface FunctionTypeNode extends RsglNode {
  kind: "FunctionType";
  parameters: TypeNode[];
  returnType: TypeNode;
}

export interface UnionTypeNode extends RsglNode {
  kind: "UnionType";
  options: TypeNode[];
}

export interface ObjectTypeNode extends RsglNode {
  kind: "ObjectType";
  properties: ObjectTypePropertyNode[];
}

export interface ObjectTypePropertyNode extends RsglNode {
  kind: "ObjectTypeProperty";
  name: IdentifierNode | null;
  optional: boolean;
  typeAnnotation: TypeNode;
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

export type TemplateOutputDialect = "resources" | "model" | "variants" | "multipart";
export type DeclaredTemplateOutputDialect = Exclude<TemplateOutputDialect, "resources">;

export type TemplateBodyNode = BlockNode | ResourceBodyNode | VariantBodyNode | MultipartBodyNode;

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

export type BlockstateMode = "variants" | "multipart";

/** Direct canonical `blockstate variants <id> { ... }` root body. */
export interface BlockstateVariantsRootBodyNode extends RsglNode {
  kind: "BlockstateVariantsRootBody";
  statements: BlockstateVariantsRootStatementNode[];
}

/** Direct canonical `blockstate multipart <id> { ... }` root body. */
export interface BlockstateMultipartRootBodyNode extends RsglNode {
  kind: "BlockstateMultipartRootBody";
  statements: BlockstateMultipartRootStatementNode[];
}

/**
 * Recovery/compatibility body for blockstate declarations without a valid
 * mode header. It may represent legacy wrappers or otherwise ambiguous root
 * statements, but is never a canonical blockstate root.
 */
export interface LegacyBlockstateRootBodyNode extends RsglNode {
  kind: "LegacyBlockstateRootBody";
  statements: LegacyBlockstateRootStatementNode[];
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
  namespaceName?: IdentifierNode;
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

export interface ExternDeclNode extends StatementNodeBase {
  kind: "ExternDecl";
  source: ExternResourceSource | null;
  resourceKind: IdentifierNode | null;
  patterns: ExternPatternNode[];
  skipExistenceCheck: boolean;
}

export interface ExternPatternNode extends RsglNode {
  kind: "ExternPattern";
  /** The original contiguous pattern text, without normalization or expansion. */
  text: string;
}

export interface TypeAliasDeclNode extends StatementNodeBase {
  kind: "TypeAliasDecl";
  name: IdentifierNode | null;
  typeAnnotation: TypeNode;
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
  /** Public output dialect written after an explicit arrow. */
  declaredOutputDialect?: DeclaredTemplateOutputDialect;
  /** Parser-level syntax fact; semantic output metadata is stored on the symbol. */
  outputSyntax: "noArrow" | "explicitArrow";
  body: TemplateBodyNode;
}

export type ResourceKind = RsglResourceKind;

interface ResourceDeclNodeBase extends StatementNodeBase {
  kind: "ResourceDecl";
  subtype?: IdentifierNode;
  id?: ExprNode;
  impl?: ExprNode;
}

export interface NonBlockstateResourceDeclNode extends ResourceDeclNodeBase {
  resourceKind: Exclude<ResourceKind, "blockstate">;
  body: ResourceBodyNode;
}

export interface BlockstateVariantsResourceDeclNode extends ResourceDeclNodeBase {
  resourceKind: "blockstate";
  blockstateSyntax: "modeHeader";
  mode: "variants";
  modeNode: IdentifierNode;
  id: ExprNode;
  body: BlockstateVariantsRootBodyNode;
}

export interface BlockstateMultipartResourceDeclNode extends ResourceDeclNodeBase {
  resourceKind: "blockstate";
  blockstateSyntax: "modeHeader";
  mode: "multipart";
  modeNode: IdentifierNode;
  id: ExprNode;
  body: BlockstateMultipartRootBodyNode;
}

export type BlockstateResourceDeclNode =
  | BlockstateVariantsResourceDeclNode
  | BlockstateMultipartResourceDeclNode;

export interface LegacyBlockstateResourceDeclNode extends ResourceDeclNodeBase {
  resourceKind: "blockstate";
  blockstateSyntax: "legacyMissingMode" | "invalidMode";
  mode: null;
  modeNode?: IdentifierNode;
  id: ExprNode;
  body: LegacyBlockstateRootBodyNode;
}

export type ResourceDeclNode =
  | NonBlockstateResourceDeclNode
  | BlockstateResourceDeclNode
  | LegacyBlockstateResourceDeclNode;

export interface ForDimensionNode extends RsglNode {
  kind: "ForDimension";
  bindings: IdentifierNode[];
  iterable: ExprNode;
}

export interface UseDeclNode extends StatementNodeBase {
  kind: "UseDecl";
  expression: ExprNode;
}

export interface ForStmtNode extends StatementNodeBase {
  kind: "ForStmt";
  bindings: IdentifierNode[];
  iterable: ExprNode;
  dimensions: ForDimensionNode[];
  body:
    | BlockNode
    | ResourceBodyNode
    | VariantBodyNode
    | MultipartBodyNode
    | BlockstateVariantsRootBodyNode
    | BlockstateMultipartRootBodyNode
    | LegacyBlockstateRootBodyNode;
}

export interface IfStmtNode extends StatementNodeBase {
  kind: "IfStmt";
  condition: ExprNode;
  thenBody:
    | BlockNode
    | ResourceBodyNode
    | VariantBodyNode
    | MultipartBodyNode
    | BlockstateVariantsRootBodyNode
    | BlockstateMultipartRootBodyNode
    | LegacyBlockstateRootBodyNode;
  elseBody?:
    | BlockNode
    | ResourceBodyNode
    | VariantBodyNode
    | MultipartBodyNode
    | BlockstateVariantsRootBodyNode
    | BlockstateMultipartRootBodyNode
    | LegacyBlockstateRootBodyNode;
}

export interface UnknownStmtNode extends StatementNodeBase {
  kind: "UnknownStmt";
}

export type ResourceStatementNode =
  | LetDeclNode
  | ExternVarStmtNode
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
  | BlockstateVariantEntryNode
  | MultipartEntryNode
  | BlockstateMultipartEntryNode
  | UseDeclNode
  | ForStmtNode
  | IfStmtNode
  | PackFormatsStmtNode
  | PackOverlayStmtNode
  | PackFilterBlockStmtNode
  | AtlasDirectoryStmtNode
  | AtlasFilterStmtNode
  | AtlasPalettedPermutationsStmtNode
  | EquipmentLayerStmtNode
  | ModelTextureStmtNode
  | ModelElementStmtNode
  | BaseStmtNode
  | MergeStmtNode
  | UnknownStmtNode;

export interface ExternVarStmtNode extends StatementNodeBase {
  kind: "ExternVarStmt";
  /** Texture variable names without their leading '#'. */
  variables: IdentifierNode[];
}

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
  /** Legacy nested wrapper retained only for compatibility/migration. */
  syntax: "legacyWrapper";
  entries: VariantSectionStatementNode[];
}

export interface VariantEntryNode extends StatementNodeBase {
  kind: "VariantEntry";
  /** Legacy selector/arrow entry retained only for compatibility/migration. */
  syntax: "legacy";
  state: ExprNode;
  value: ExprNode;
}

export interface BlockstateVariantEntryNode extends StatementNodeBase {
  kind: "BlockstateVariantEntry";
  selector: ExprNode;
  selectorSyntax: "inlineObject" | "parenthesizedExpression";
  value: BlockstateApplyValueNode;
}

export type VariantSectionStatementNode =
  | BlockstateVariantEntryNode
  | VariantEntryNode
  | LetDeclNode
  | UseDeclNode
  | ForStmtNode
  | IfStmtNode
  | UnknownStmtNode;

export interface MultipartSectionNode extends StatementNodeBase {
  kind: "MultipartSection";
  /** Legacy nested wrapper retained only for compatibility/migration. */
  syntax: "legacyWrapper";
  entries: MultipartSectionStatementNode[];
}

export interface MultipartEntryNode extends StatementNodeBase {
  kind: "MultipartEntry";
  /** Legacy wrapper entry retained only for compatibility/migration. */
  syntax: "legacy";
  when?: ExprNode;
  apply: ExprNode;
}

export interface BlockstateMultipartEntryNode extends StatementNodeBase {
  kind: "BlockstateMultipartEntry";
  when?: ExprNode;
  apply: BlockstateApplyValueNode;
}

export type MultipartSectionStatementNode =
  | BlockstateMultipartEntryNode
  | MultipartEntryNode
  | LetDeclNode
  | UseDeclNode
  | ForStmtNode
  | IfStmtNode
  | UnknownStmtNode;

export interface BlockstateModelPropertyNode extends RsglNode {
  kind: "BlockstateModelProperty";
  name: IdentifierNode;
  value: ExprNode;
}

export interface BlockstateApplyExprNode extends RsglNode {
  kind: "BlockstateApplyExpr";
  head: ExprNode;
  properties: BlockstateModelPropertyNode[];
}

export interface BlockstateRandomItemNode extends RsglNode {
  kind: "BlockstateRandomItem";
  head: ExprNode;
  properties: BlockstateModelPropertyNode[];
}

export interface BlockstateRandomValueNode extends RsglNode {
  kind: "BlockstateRandomValue";
  items: BlockstateRandomItemNode[];
}

export type BlockstateApplyValueNode = BlockstateApplyExprNode | BlockstateRandomValueNode;

export interface PackFormatsStmtNode extends StatementNodeBase {
  kind: "PackFormatsStmt";
  min?: ExprNode;
  max?: ExprNode;
}

export interface PackOverlayStmtNode extends StatementNodeBase {
  kind: "PackOverlayStmt";
  directory: ExprNode;
  body: ResourceBodyNode;
}

export interface PackFilterBlockStmtNode extends StatementNodeBase {
  kind: "PackFilterBlockStmt";
  namespace?: ExprNode;
  path?: ExprNode;
}

export interface AtlasDirectoryStmtNode extends StatementNodeBase {
  kind: "AtlasDirectoryStmt";
  source?: ExprNode;
  prefix?: ExprNode;
}

export interface AtlasFilterStmtNode extends StatementNodeBase {
  kind: "AtlasFilterStmt";
  namespace?: ExprNode;
  path?: ExprNode;
}

export interface AtlasPalettedPermutationsStmtNode extends StatementNodeBase {
  kind: "AtlasPalettedPermutationsStmt";
  body: ResourceBodyNode;
}

export interface EquipmentLayerStmtNode extends StatementNodeBase {
  kind: "EquipmentLayerStmt";
  layer: ExprNode;
  texture?: ExprNode;
  dyeable?: ExprNode;
  color?: ExprNode;
  usePlayerTexture?: ExprNode;
}

export interface ModelTextureStmtNode extends StatementNodeBase {
  kind: "ModelTextureStmt";
  key: IdentifierNode;
  value: ExprNode;
}

export interface ModelGeometryPropertyNode extends RsglNode {
  kind: "ModelGeometryProperty";
  name: IdentifierNode;
  value: ExprNode;
}

export interface ModelFaceClauseNode extends RsglNode {
  kind: "ModelFaceClause";
  target: IdentifierNode;
  properties: ModelGeometryPropertyNode[];
}

export interface ModelElementStmtNode extends StatementNodeBase {
  kind: "ModelElementStmt";
  elementKind: "box" | "element";
  label?: ExprNode;
  from?: ExprNode;
  to?: ExprNode;
  properties: ModelGeometryPropertyNode[];
  faces: ModelFaceClauseNode[];
}

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

export interface BaseStmtNode extends StatementNodeBase {
  kind: "BaseStmt";
  path: ExprNode;
}

export type MergeMode = "shallow" | "deep" | "strict" | "upsert" | "append";
export type ExplicitMergeMode = Exclude<MergeMode, "shallow">;

export interface MergeModifierNode extends RsglNode {
  kind: "MergeModifier";
  mode: ExplicitMergeMode;
  text: string;
}

export interface MergeStmtNode extends StatementNodeBase {
  kind: "MergeStmt";
  mode: MergeMode;
  modifier?: MergeModifierNode;
  value: ExprNode;
}

export type BlockstateRootCommonStatementNode =
  | LetDeclNode
  | UseDeclNode
  | ForStmtNode
  | IfStmtNode
  | BaseStmtNode
  | MergeStmtNode
  | PropertyStmtNode
  | UnknownStmtNode
  | VariantsSectionNode
  | MultipartSectionNode;

export type BlockstateVariantsRootStatementNode =
  | BlockstateRootCommonStatementNode
  | BlockstateVariantEntryNode
  | VariantEntryNode;

export type BlockstateMultipartRootStatementNode =
  | BlockstateRootCommonStatementNode
  | BlockstateMultipartEntryNode
  | MultipartEntryNode;

export type LegacyBlockstateRootStatementNode =
  | BlockstateRootCommonStatementNode
  | BlockstateVariantEntryNode
  | VariantEntryNode
  | BlockstateMultipartEntryNode
  | MultipartEntryNode;

export interface LexResult {
  tokens: RsglToken[];
  diagnostics: RsglDiagnostic[];
}
