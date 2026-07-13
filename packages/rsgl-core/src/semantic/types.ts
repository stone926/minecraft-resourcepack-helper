import {
  ExprNode,
  ExportDeclNode,
  IdentifierNode,
  ImportDeclNode,
  ResourceDeclNode,
  RsglDiagnostic,
  RsglModule,
  RsglNode,
  TextRange,
  TypeNode
} from "../parser";
import type { ExternResourceKind } from "../resourceKinds";

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
}

export interface RsglSignature {
  parameters: RsglParameterSymbol[];
  returnType: RsglType;
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
   * Enclosing scope of each imported-template call whose arguments the binder
   * skipped (signature unknown at bind time). Lets post-resolution validation
   * check lambda arguments with the captures the call site actually sees.
   */
  importCallScopes?: ReadonlyMap<ExprNode, RsglScope>;
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
export const jsonType: RsglType = { kind: "Json" };

export function typeFromAnnotation(typeNode: TypeNode | undefined): RsglType {
  if (!typeNode) {
    return unknownType;
  }
  if (typeNode.kind === "NamedType") {
    return namedType(typeNode.name.text);
  }
  if (typeNode.kind === "GenericType") {
    const name = typeNode.name.text;
    if (name === "List") {
      return { kind: "List", elementType: typeFromAnnotation(typeNode.args[0]) };
    }
    return namedType(name);
  }
  if (typeNode.kind === "FunctionType") {
    return {
      kind: "Function",
      parameters: typeNode.parameters.map(typeFromAnnotation),
      returnType: typeFromAnnotation(typeNode.returnType)
    };
  }
  if (typeNode.kind === "UnionType") {
    return { kind: "Union", options: typeNode.options.map(typeFromAnnotation) };
  }
  if (typeNode.kind === "LiteralType") {
    return inferLiteralType(typeNode.value);
  }
  return unknownType;
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
