import type { RsglResourceKind } from "../resourceKinds";
import type { ExternResourceSource } from "../externDeclarations";

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

export type RsglStatement =
  | TopLevelStatementNode
  | ResourceStatementNode
  | BlockstateChoiceStatementNode
  | ItemSelectBodyStatementNode
  | ItemRangeBodyStatementNode
  | ItemCompositeBodyStatementNode
  | ItemFirstMatchBodyStatementNode
  | ItemModelTemplateBodyStatementNode;

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

/** A statically named Minecraft model texture slot such as `#all`. */
export interface TextureVariableLiteralNode extends RsglNode {
  kind: "TextureVariableLiteral";
  /** Slot name without the leading '#'. */
  name: IdentifierNode;
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
  key: PropertyKeyNode;
  value: ExprNode;
  /** True when `{ name }` supplies the equivalent `{ name: name }` value. */
  shorthand?: boolean;
}

export interface ObjectSpreadNode extends RsglNode {
  kind: "ObjectSpread";
  expression: ExprNode;
}

export interface DynamicKeyNode extends RsglNode {
  kind: "DynamicKey";
  expression: ExprNode;
}

/** Shared property-key syntax for object literals and resource-body fields. */
export type PropertyKeyNode =
  | IdentifierNode
  | StringLiteralNode
  | NumberLiteralNode
  | DynamicKeyNode;

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

export type ExprNode =
  | IdentifierExprNode
  | StringLiteralNode
  | NumberLiteralNode
  | BooleanLiteralNode
  | NullLiteralNode
  | ResourceLocationExprNode
  | TextureVariableLiteralNode
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

export type TemplateOutputDialect = "resources" | "model" | "variants" | "multipart" | "choice" | "item_model";
export type DeclaredTemplateOutputDialect = Exclude<TemplateOutputDialect, "resources">;

export type TemplateBodyNode =
  | BlockNode
  | ResourceBodyNode
  | VariantBodyNode
  | MultipartBodyNode
  | BlockstateChoiceBodyNode
  | ItemModelTemplateBodyNode;

/** Every statement-bearing body that can be preserved through shared control flow. */
export type RsglStatementBodyNode =
  | BlockNode
  | ResourceBodyNode
  | VariantBodyNode
  | MultipartBodyNode
  | BlockstateChoiceBodyNode
  | BlockstateVariantsRootBodyNode
  | BlockstateMultipartRootBodyNode
  | ItemSelectBodyNode
  | ItemRangeBodyNode
  | ItemCompositeBodyNode
  | ItemFirstMatchBodyNode
  | ItemModelTemplateBodyNode;

/** Kind discriminants of every statement-bearing body node. */
export type RsglBodyNodeKind = RsglStatementBodyNode["kind"];

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

/** Body that contributes options to one blockstate random choice. */
export interface BlockstateChoiceBodyNode extends RsglNode {
  kind: "BlockstateChoiceBody";
  statements: BlockstateChoiceStatementNode[];
}

export interface ItemSelectBodyNode extends RsglNode {
  kind: "ItemSelectBody";
  statements: ItemSelectBodyStatementNode[];
}

export interface ItemRangeBodyNode extends RsglNode {
  kind: "ItemRangeBody";
  statements: ItemRangeBodyStatementNode[];
}

export interface ItemCompositeBodyNode extends RsglNode {
  kind: "ItemCompositeBody";
  statements: ItemCompositeBodyStatementNode[];
}

export interface ItemFirstMatchBodyNode extends RsglNode {
  kind: "ItemFirstMatchBody";
  statements: ItemFirstMatchBodyStatementNode[];
}

/** Cardinality-one body used only by `template ... -> item_model`. */
export interface ItemModelTemplateBodyNode extends RsglNode {
  kind: "ItemModelTemplateBody";
  statements: ItemModelTemplateBodyStatementNode[];
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

interface ResourceDeclNodeBase extends StatementNodeBase {
  kind: "ResourceDecl";
  subtype?: IdentifierNode;
  id?: ExprNode;
  impl?: ExprNode;
}

export interface NonBlockstateResourceDeclNode extends ResourceDeclNodeBase {
  resourceKind: Exclude<RsglResourceKind, "blockstate">;
  body: ResourceBodyNode;
}

export interface BlockstateVariantsResourceDeclNode extends ResourceDeclNodeBase {
  resourceKind: "blockstate";
  mode: "variants";
  modeNode: IdentifierNode;
  id: ExprNode;
  body: BlockstateVariantsRootBodyNode;
}

export interface BlockstateMultipartResourceDeclNode extends ResourceDeclNodeBase {
  resourceKind: "blockstate";
  mode: "multipart";
  modeNode: IdentifierNode;
  id: ExprNode;
  body: BlockstateMultipartRootBodyNode;
}

export type BlockstateResourceDeclNode =
  | BlockstateVariantsResourceDeclNode
  | BlockstateMultipartResourceDeclNode;

export type ResourceDeclNode =
  | NonBlockstateResourceDeclNode
  | BlockstateResourceDeclNode;

export type ForBindingPatternNode =
  | IdentifierNode
  | ForObjectBindingPatternNode;

export interface ForObjectBindingPatternNode extends RsglNode {
  kind: "ForObjectBindingPattern";
  properties: ForObjectBindingPropertyNode[];
}

export interface ForObjectBindingPropertyNode extends RsglNode {
  kind: "ForObjectBindingProperty";
  /** Object property selected from each iterable element. */
  property: IdentifierNode;
  /** Local value binding introduced in the loop scope. */
  binding: IdentifierNode;
  /** True when `{ name }` supplies the equivalent `{ name: name }` binding. */
  shorthand: boolean;
}

export interface ForDimensionNode extends RsglNode {
  kind: "ForDimension";
  pattern: ForBindingPatternNode;
  /** Optional zero-based index binding introduced after this iterable. */
  indexBinding?: IdentifierNode;
  iterable: ExprNode;
}

export interface UseDeclNode extends StatementNodeBase {
  kind: "UseDecl";
  expression: ExprNode;
}

export interface ForStmtNode extends StatementNodeBase {
  kind: "ForStmt";
  dimensions: ForDimensionNode[];
  body: RsglStatementBodyNode;
}

export interface IfStmtNode extends StatementNodeBase {
  kind: "IfStmt";
  condition: ExprNode;
  thenBody: RsglStatementBodyNode;
  elseBody?: RsglStatementBodyNode;
}

export interface UnknownStmtNode extends StatementNodeBase {
  kind: "UnknownStmt";
}

export type ResourceStatementNode =
  | LetDeclNode
  | ExternVarStmtNode
  | PropertyStmtNode
  | SectionStmtNode
  | ItemModelProducerStmtNode
  | BlockstateVariantEntryNode
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
  | ModelTransformStmtNode
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
  key: PropertyKeyNode;
  value: ExprNode;
}

export interface SectionStmtNode extends StatementNodeBase {
  kind: "SectionStmt";
  name: IdentifierNode;
  body?: ResourceBodyNode;
  value?: ExprNode;
}

export interface BlockstateVariantEntryNode extends StatementNodeBase {
  kind: "BlockstateVariantEntry";
  selector: ExprNode | BlockstateWildcardSelectorNode;
  choice: BlockstateChoiceNode;
}

export interface BlockstateWildcardSelectorNode extends RsglNode {
  kind: "BlockstateWildcardSelector";
}

export type VariantSectionStatementNode =
  | BlockstateVariantEntryNode
  | LetDeclNode
  | UseDeclNode
  | ForStmtNode
  | IfStmtNode
  | UnknownStmtNode;

export interface BlockstateMultipartEntryNode extends StatementNodeBase {
  kind: "BlockstateMultipartEntry";
  predicate?: ExprNode;
  always: boolean;
  choice: BlockstateChoiceNode;
}

export type MultipartSectionStatementNode =
  | BlockstateMultipartEntryNode
  | LetDeclNode
  | UseDeclNode
  | ForStmtNode
  | IfStmtNode
  | UnknownStmtNode;

export interface BlockstateModelSpecNode extends RsglNode {
  kind: "BlockstateModelSpec";
  model: ExprNode;
  options?: ObjectExprNode;
}

export interface BlockstateRandomChoiceNode extends RsglNode {
  kind: "BlockstateRandomChoice";
  body: BlockstateChoiceBodyNode;
}

export type BlockstateChoiceNode = BlockstateModelSpecNode | BlockstateRandomChoiceNode;

export interface BlockstateRandomOptionNode extends StatementNodeBase {
  kind: "BlockstateRandomOption";
  model: BlockstateModelSpecNode;
  weight?: ExprNode;
}

export type BlockstateChoiceStatementNode =
  | BlockstateRandomOptionNode
  | LetDeclNode
  | UseDeclNode
  | ForStmtNode
  | IfStmtNode
  | UnknownStmtNode;

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

export type ModelTransformAxis = "x" | "y" | "z";

/** Controlled model-body geometry copy; never an ordinary JSON property. */
export interface ModelTransformStmtNode extends StatementNodeBase {
  kind: "ModelTransformStmt";
  operation: IdentifierNode;
  axis: ModelTransformAxis | null;
  angle: ExprNode;
  pivot: ExprNode;
  body: ResourceBodyNode;
}

export interface ItemOptionNode extends RsglNode {
  kind: "ItemOption";
  name: IdentifierNode;
  value: ExprNode;
}

/** An arbitrary RSGL expression used as an item-model node, optionally with leaf options. */
export interface ItemModelExprNode extends RsglNode {
  kind: "ItemModelExpr";
  expression: ExprNode;
  options?: ObjectExprNode;
}

export interface ItemModelUseNode extends RsglNode {
  kind: "ItemModelUse";
  expression: ExprNode;
}

export interface ItemSelectCaseNode extends StatementNodeBase {
  kind: "ItemSelectCase";
  when: ExprNode;
  model: ItemModelNode;
}

export interface ItemRangeEntryNode extends StatementNodeBase {
  kind: "ItemRangeEntry";
  threshold: ExprNode;
  model: ItemModelNode;
}

export interface ItemRangeFramesNode extends StatementNodeBase {
  kind: "ItemRangeFrames";
  frames: ExprNode;
  model: ItemModelNode;
}

export interface ItemFallbackClauseNode extends StatementNodeBase {
  kind: "ItemFallbackClause";
  model: ItemModelNode;
}

export interface ItemCompositeModelNode extends StatementNodeBase {
  kind: "ItemCompositeModel";
  model: ItemModelNode;
}

export interface ItemFirstMatchWhenNode extends StatementNodeBase {
  kind: "ItemFirstMatchWhen";
  property: ExprNode;
  propertyOptions: ItemOptionNode[];
  model: ItemModelNode;
}

export type ItemSelectBodyStatementNode =
  | ItemSelectCaseNode
  | ItemFallbackClauseNode
  | LetDeclNode
  | ForStmtNode
  | IfStmtNode
  | UnknownStmtNode;

export type ItemRangeBodyStatementNode =
  | ItemRangeEntryNode
  | ItemRangeFramesNode
  | ItemFallbackClauseNode
  | LetDeclNode
  | ForStmtNode
  | IfStmtNode
  | UnknownStmtNode;

export type ItemCompositeBodyStatementNode =
  | ItemCompositeModelNode
  | LetDeclNode
  | ForStmtNode
  | IfStmtNode
  | UnknownStmtNode;

export type ItemFirstMatchBodyStatementNode =
  | ItemFirstMatchWhenNode
  | ItemFallbackClauseNode
  | LetDeclNode
  | ForStmtNode
  | IfStmtNode
  | UnknownStmtNode;

export type ItemModelTemplateBodyStatementNode =
  | ItemModelProducerStmtNode
  | LetDeclNode
  | UseDeclNode
  | ForStmtNode
  | IfStmtNode
  | UnknownStmtNode;

export interface ItemModelRangeNode extends RsglNode {
  kind: "ItemModelRange";
  property: ExprNode;
  propertyOptions: ItemOptionNode[];
  body: ItemRangeBodyNode;
  options?: ObjectExprNode;
}

export interface ItemModelSelectNode extends RsglNode {
  kind: "ItemModelSelect";
  property: ExprNode;
  propertyOptions: ItemOptionNode[];
  body: ItemSelectBodyNode;
  options?: ObjectExprNode;
}

export interface ItemModelConditionNode extends RsglNode {
  kind: "ItemModelCondition";
  property: ExprNode;
  propertyOptions: ItemOptionNode[];
  onTrue?: ItemModelNode;
  onFalse?: ItemModelNode;
  options?: ObjectExprNode;
}

export interface ItemModelCompositeNode extends RsglNode {
  kind: "ItemModelComposite";
  body: ItemCompositeBodyNode;
  options?: ObjectExprNode;
}

export interface ItemModelFirstMatchNode extends RsglNode {
  kind: "ItemModelFirstMatch";
  body: ItemFirstMatchBodyNode;
  options?: ObjectExprNode;
}

export interface ItemModelEmptyNode extends RsglNode {
  kind: "ItemModelEmpty";
}

export interface ItemModelSelectedItemNode extends RsglNode {
  kind: "ItemModelSelectedItem";
}

export interface ItemModelSpecialNode extends RsglNode {
  kind: "ItemModelSpecial";
  base: ExprNode;
  model: ExprNode;
  options?: ObjectExprNode;
}

export type ItemModelNode =
  | ItemModelExprNode
  | ItemModelUseNode
  | ItemModelRangeNode
  | ItemModelSelectNode
  | ItemModelConditionNode
  | ItemModelCompositeNode
  | ItemModelFirstMatchNode
  | ItemModelEmptyNode
  | ItemModelSelectedItemNode
  | ItemModelSpecialNode;

export type ItemModelProducerSurfaceKind =
  | "modelExpression"
  | "rawProperty"
  | "structured"
  | "terminal";

export interface ItemModelProducerStmtNode extends StatementNodeBase {
  kind: "ItemModelProducerStmt";
  value: ItemModelNode;
  surfaceKind: ItemModelProducerSurfaceKind;
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
  | UnknownStmtNode;

export type BlockstateVariantsRootStatementNode =
  | BlockstateRootCommonStatementNode
  | BlockstateVariantEntryNode;

export type BlockstateMultipartRootStatementNode =
  | BlockstateRootCommonStatementNode
  | BlockstateMultipartEntryNode;

export interface LexResult {
  tokens: RsglToken[];
  diagnostics: RsglDiagnostic[];
}
