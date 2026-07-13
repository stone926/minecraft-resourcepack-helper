import {
  BlockstateApplyExprNode,
  BlockstateRandomItemNode,
  ExprNode,
  ExportDeclNode,
  IdentifierNode,
  ImportDeclNode,
  ResourceDeclNode,
  RsglDiagnostic,
  RsglModule,
  RsglNode,
  TemplateDeclNode,
  TextRange,
  TypeNode
} from "../parser";
import type { ExternResourceKind } from "../resourceKinds";
import type {
  ResolvedTemplateOutputConflict,
  ResolvedTemplateOutputMetadata,
  RsglTemplateCallerContext
} from "../templateOutput";

export type RsglSymbolKind =
  | "builtin"
  | "import"
  | "namespace"
  | "variable"
  | "table"
  | "template"
  | "parameter"
  | "resource";

export type RsglTypeKind =
  | "Unknown"
  | "Any"
  | "String"
  | "Number"
  | "Boolean"
  | "Null"
  | "ResourceId"
  | "ModelId"
  | "TextureId"
  | "TextureVariable"
  | "TextureRef"
  | "BlockstateModelObject"
  | "Path"
  | "Json"
  | "List"
  | "Object"
  | "Range"
  | "Function"
  | "Union";

export interface RsglType {
  kind: RsglTypeKind;
  elementType?: RsglType;
  properties?: Map<string, RsglType>;
  parameters?: RsglType[];
  returnType?: RsglType;
  options?: RsglType[];
  /** Internal provenance used by contextual compatibility escapes. */
  explicitAnnotation?: true;
}

export type RsglBlockstateApplySiteNode = BlockstateApplyExprNode | BlockstateRandomItemNode;

export type RsglBlockstateApplyExpectation =
  | "modelIdOnly"
  | "modelOrObject"
  | "modelOrObjectOrFlatList";

export interface RsglBlockstateApplyFact {
  expectation: RsglBlockstateApplyExpectation;
  actualType: RsglType;
  unknownFields: "reject" | "preserveExplicitJson";
}

export interface RsglBlockstateApplyRecord {
  node: RsglBlockstateApplySiteNode;
  scope: RsglScope;
}

export type RsglBlockstateContextualExpression =
  | {
      kind: "selector";
      expression: ExprNode;
      selectorSyntax: "inlineObject" | "parenthesizedExpression";
    }
  | {
      kind: "condition";
      expression: ExprNode;
    };

export type RsglBlockstateContextualExpressionRecord =
  RsglBlockstateContextualExpression & { scope: RsglScope };

export interface RsglSignature {
  parameters: RsglParameterSymbol[];
  returnType: RsglType;
  templateOutput?: ResolvedTemplateOutputMetadata;
  templateOutputConflict?: ResolvedTemplateOutputConflict;
}

export interface RsglTemplateUseRecord {
  expression: ExprNode;
  /** Undefined only inside a legacy contextual template whose caller chooses the body dialect. */
  callerContext?: RsglTemplateCallerContext;
  scope: RsglScope;
  enclosingTemplate?: TemplateDeclNode;
}

export interface RsglLegacyBlockstateRootRecord {
  range: TextRange;
  directModes: readonly ("variants" | "multipart")[];
  /** Only wrapper-less root uses participate in declaration-mode inference. */
  uses: readonly RsglTemplateUseRecord[];
}

export interface RsglContextualTextureSinkRecord {
  expression: ExprNode;
  actualType: RsglType;
  scope: RsglScope;
  enclosingTemplate: TemplateDeclNode;
}

export interface RsglParameterSymbol {
  name: string;
  type: RsglType;
  optional: boolean;
  node?: RsglNode;
}

export interface RsglSymbol {
  name: string;
  kind: RsglSymbolKind;
  type: RsglType;
  node?: RsglNode;
  range?: TextRange;
  signature?: RsglSignature;
  finiteDomain?: string[];
}

export interface RsglScope {
  kind: "global" | "module" | "block" | "template" | "loop" | "lambda";
  parent?: RsglScope;
  symbols: Map<string, RsglSymbol>;
}

export interface RsglImportRecord {
  source: string;
  node: ImportDeclNode;
  defaultName?: string;
  importAll?: boolean;
  namedImports: Array<{ imported: string; local: string; range: TextRange }>;
  resolvedFileName?: string;
}

export interface RsglExportRecord {
  source?: string;
  node: ExportDeclNode;
  exportAll: boolean;
  specifiers: Array<{ local: string; exported: string; range: TextRange }>;
  resolvedFileName?: string;
}

export interface RsglImportGraph {
  files: string[];
  edges: Array<{ from: string; to: string; source: string; range: TextRange }>;
  cycles: string[][];
  missing: Array<{ from: string; source: string; range: TextRange }>;
}

export interface RsglReferenceRecord {
  name: string;
  range: TextRange;
  symbol?: RsglSymbol;
}

export interface RsglOutputResourcePreview {
  kind: ResourceDeclNode["resourceKind"] | ExternResourceKind;
  id?: string;
  node: RsglNode;
}

export interface RsglSemanticModel {
  fileName: string;
  module: RsglModule;
  scope: RsglScope;
  symbols: RsglSymbol[];
  imports: RsglImportRecord[];
  exports: RsglExportRecord[];
  references: RsglReferenceRecord[];
  outputResources: RsglOutputResourcePreview[];
  diagnostics: RsglDiagnostic[];
  namespace?: string;
  /**
   * Enclosing scope of each known import call and unresolved call that may be
   * linked by a bare import. Lets post-resolution validation use the captures
   * and local values the call site actually sees.
   */
  importCallScopes?: ReadonlyMap<ExprNode, RsglScope>;
  templateUses?: readonly RsglTemplateUseRecord[];
  /** Legacy declaration roots retained for exact post-link mode inference. */
  legacyBlockstateRoots?: readonly RsglLegacyBlockstateRootRecord[];
  contextualTextureSinks?: readonly RsglContextualTextureSinkRecord[];
  /** Final semantic policy consumed by blockstate runtime lowering. */
  blockstateApplyFacts?: ReadonlyMap<RsglBlockstateApplySiteNode, RsglBlockstateApplyFact>;
  /** Source-position scopes retained for the post-link import/re-export pass. */
  blockstateApplyRecords?: readonly RsglBlockstateApplyRecord[];
  /** Contextual selectors/conditions rechecked after imported types are linked. */
  blockstateContextualExpressionRecords?: readonly RsglBlockstateContextualExpressionRecord[];
}

export interface RsglSourceFile {
  fileName: string;
  module: RsglModule;
}

export interface RsglProgram {
  files: RsglSourceFile[];
  models: RsglSemanticModel[];
  importGraph: RsglImportGraph;
  diagnostics: RsglDiagnostic[];
  fileDiagnostics: RsglFileDiagnostic[];
  semanticConfigurationFingerprint?: string;
}

export interface RsglFileDiagnostic extends RsglDiagnostic {
  fileName: string;
}

export interface RsglModuleResolver {
  resolveImport(fromFileName: string, source: string): string | null;
}

export interface RsglBindOptions {
  fileName?: string;
  resolver?: RsglModuleResolver;
  semanticConfigurationFingerprint?: string;
  /** Overrides the directory the bundled RSGL stdlib is discovered from (test seam). */
  stdlibRoot?: string;
}

export const unknownType: RsglType = { kind: "Unknown" };
export const anyType: RsglType = { kind: "Any" };
export const stringType: RsglType = { kind: "String" };
export const numberType: RsglType = { kind: "Number" };
export const booleanType: RsglType = { kind: "Boolean" };
export const nullType: RsglType = { kind: "Null" };
export const resourceIdType: RsglType = { kind: "ResourceId" };
export const modelIdType: RsglType = { kind: "ModelId" };
export const textureIdType: RsglType = { kind: "TextureId" };
export const textureVariableType: RsglType = { kind: "TextureVariable" };
export const textureRefType: RsglType = { kind: "TextureRef" };
export const blockstateModelObjectType: RsglType = { kind: "BlockstateModelObject" };
export const jsonType: RsglType = { kind: "Json" };

export function typeFromAnnotation(typeNode: TypeNode | undefined): RsglType {
  if (!typeNode) {
    return unknownType;
  }
  if (typeNode.kind === "NamedType") {
    return explicitlyAnnotated(namedType(typeNode.name.text));
  }
  if (typeNode.kind === "GenericType") {
    const name = typeNode.name.text;
    if (name === "List") {
      return {
        kind: "List",
        elementType: typeFromAnnotation(typeNode.args[0]),
        explicitAnnotation: true
      };
    }
    return explicitlyAnnotated(namedType(name));
  }
  if (typeNode.kind === "FunctionType") {
    return {
      kind: "Function",
      parameters: typeNode.parameters.map(typeFromAnnotation),
      returnType: typeFromAnnotation(typeNode.returnType),
      explicitAnnotation: true
    };
  }
  if (typeNode.kind === "UnionType") {
    return {
      kind: "Union",
      options: typeNode.options.map(typeFromAnnotation),
      explicitAnnotation: true
    };
  }
  if (typeNode.kind === "LiteralType") {
    return explicitlyAnnotated(inferLiteralType(typeNode.value));
  }
  return unknownType;
}

function explicitlyAnnotated(type: RsglType): RsglType {
  return { ...type, explicitAnnotation: true };
}

export function namedType(name: string): RsglType {
  if (name === "String" || name === "Path") {
    return { kind: name };
  }
  if (name === "Number" || name === "Boolean" || name === "Json" || name === "Function") {
    return { kind: name };
  }
  if (name === "ResourceId") {
    return resourceIdType;
  }
  if (name === "ModelId") {
    return modelIdType;
  }
  if (name === "TextureId") {
    return textureIdType;
  }
  if (name === "TextureVariable") {
    return textureVariableType;
  }
  if (name === "TextureRef") {
    return textureRefType;
  }
  if (name === "Range") {
    return { kind: "Range", elementType: numberType };
  }
  return unknownType;
}

export function inferLiteralType(node: ExprNode): RsglType {
  if (node.kind === "StringLiteral" || node.kind === "TemplateStringExpr") {
    return stringType;
  }
  if (node.kind === "NumberLiteral") {
    return numberType;
  }
  if (node.kind === "BooleanLiteral") {
    return booleanType;
  }
  if (node.kind === "NullLiteral") {
    return nullType;
  }
  if (node.kind === "ResourceLocationExpr") {
    return resourceIdType;
  }
  return unknownType;
}

export function identifierName(identifier: IdentifierNode | null | undefined): string | null {
  return identifier?.text ?? null;
}
