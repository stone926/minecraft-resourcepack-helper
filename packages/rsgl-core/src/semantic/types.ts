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
  TypeAliasDeclNode,
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

/** Observable effect class for callable builtin symbols. */
export type RsglBuiltinEffect = "pure" | "io";

export type RsglTypeKind =
  | "Unknown"
  | "Any"
  | "Never"
  | "TypeParameter"
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
  | "ModuleNamespace"
  | "List"
  | "Object"
  | "Range"
  | "Function"
  | "Union"
  | "Missing";

/** Metadata retained for a statically named structural object property. */
export interface RsglObjectProperty {
  type: RsglType;
  optional: boolean;
  declarationRange?: TextRange;
}

export interface RsglType {
  kind: RsglTypeKind;
  /** Internal generic placeholder used only by builtin signatures. */
  typeParameterName?: string;
  /** Exact scalar value retained for discriminated records and literal unions. */
  literalValue?: string | number | boolean | null;
  elementType?: RsglType;
  properties?: Map<string, RsglObjectProperty>;
  /** Value type for computed or otherwise not statically named object keys. */
  indexType?: RsglType;
  /** Dynamic keys may address properties outside the statically known shape. */
  open?: boolean;
  parameters?: RsglType[];
  returnType?: RsglType;
  options?: RsglType[];
  /** Internal provenance used by contextual compatibility escapes. */
  explicitAnnotation?: true;
  /** Internal union arm accepted only when static checking proves explicit Json. */
  contextualEscapeOnly?: true;
  /** Nominal module identity and linked value/template members. */
  moduleNamespaceId?: string;
  moduleNamespaceMembers?: ReadonlyMap<string, RsglModuleNamespaceMember>;
}

export function objectProperty(
  type: RsglType,
  optional = false,
  declarationRange?: TextRange
): RsglObjectProperty {
  return {
    type,
    optional,
    ...(declarationRange ? { declarationRange } : {})
  };
}

export function objectPropertyType(property: RsglObjectProperty | undefined): RsglType | undefined {
  return property?.type;
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
  /** Internal generic parameters instantiated by builtin-specific inference. */
  typeParameters?: RsglGenericParameter[];
  /** Stable named signature produced by a let-bound lambda value. */
  valueFunction?: true;
  templateOutput?: ResolvedTemplateOutputMetadata;
  templateOutputConflict?: ResolvedTemplateOutputConflict;
}

export interface RsglGenericParameter {
  name: string;
  constraint?: "value" | "iterable" | "record";
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
  /** Builtin-only positional rest parameter. User lambdas/templates never set this. */
  rest?: true;
  node?: RsglNode;
}

export interface RsglSymbol {
  name: string;
  kind: RsglSymbolKind;
  type: RsglType;
  /** Present on callable builtin symbols and sourced from the builtin registry. */
  effect?: RsglBuiltinEffect;
  node?: RsglNode;
  range?: TextRange;
  signature?: RsglSignature;
  finiteDomain?: string[];
}

export type RsglModuleNamespaceMemberCategory = "value" | "template";

/** A linked module export retained with its original semantic identity. */
export interface RsglModuleNamespaceMember {
  name: string;
  category: RsglModuleNamespaceMemberCategory;
  symbol: RsglSymbol;
  sourceFile: string;
}

export interface RsglScope {
  kind: "global" | "module" | "block" | "template" | "loop" | "lambda";
  parent?: RsglScope;
  symbols: Map<string, RsglSymbol>;
  /** Type aliases deliberately occupy a namespace independent from values/templates. */
  typeAliases: Map<string, RsglTypeAliasSymbol>;
}

export interface RsglTypeAliasSymbol {
  name: string;
  node: TypeAliasDeclNode;
  scope: RsglScope;
  state: "unresolved" | "resolving" | "resolved";
  type?: RsglType;
  invalid?: boolean;
  circularDiagnosticReported?: boolean;
  /** Set only when the detected alias cycle spans independently owned module scopes. */
  circularAcrossScopes?: boolean;
}

export interface RsglImportRecord {
  source: string;
  node: ImportDeclNode;
  defaultName?: string;
  namespaceName?: string;
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
  /** Final contextual types selected for expressions at typed boundaries. */
  resolvedExpectedTypes: ReadonlyMap<ExprNode, RsglType>;
  /** Final expression types retained for completion, hover, and member queries. */
  resolvedExpressionTypes?: ReadonlyMap<ExprNode, RsglType>;
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
  typeAliasExportMaps?: ReadonlyMap<string, ReadonlyMap<string, RsglTypeAliasSymbol>>;
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
  /** Type imports resolved from the program declaration graph before semantic checking. */
  prelinkedTypeAliases?: ReadonlyMap<string, RsglTypeAliasSymbol>;
  /** Named imports proven to exist only in the type namespace. */
  typeOnlyImportNames?: ReadonlySet<string>;
  /** Namespace imports resolved by the bounded program prelink pass. */
  prelinkedModuleNamespaces?: ReadonlyMap<string, RsglType>;
}

export const unknownType: RsglType = { kind: "Unknown" };
export const anyType: RsglType = { kind: "Any" };
/** Internal bottom type used by empty collection inference. */
export const neverType: RsglType = { kind: "Never" };
export const stringType: RsglType = { kind: "String" };
export const numberType: RsglType = { kind: "Number" };
export const booleanType: RsglType = { kind: "Boolean" };
export const nullType: RsglType = { kind: "Null" };
/** Internal absence sentinel. It is never accepted as a source-level named type. */
export const missingType: RsglType = { kind: "Missing" };
export const resourceIdType: RsglType = { kind: "ResourceId" };
export const modelIdType: RsglType = { kind: "ModelId" };
export const textureIdType: RsglType = { kind: "TextureId" };
export const textureVariableType: RsglType = { kind: "TextureVariable" };
export const textureRefType: RsglType = { kind: "TextureRef" };
export const blockstateModelObjectType: RsglType = { kind: "BlockstateModelObject" };
export const jsonType: RsglType = { kind: "Json" };

export function typeFromAnnotation(
  typeNode: TypeNode | undefined,
  scope?: RsglScope,
  diagnostics?: RsglDiagnostic[],
  aliasStack: RsglTypeAliasSymbol[] = []
): RsglType {
  if (!typeNode) {
    return unknownType;
  }
  if (typeNode.kind === "NamedType") {
    const builtin = namedType(typeNode.name.text);
    if (builtin.kind !== "Unknown") {
      return explicitlyAnnotated(builtin);
    }
    const alias = scope ? lookupTypeAliasInScope(scope, typeNode.name.text) : undefined;
    if (alias) {
      return explicitlyAnnotated(resolveTypeAliasSymbol(alias, diagnostics, aliasStack));
    }
    reportUnknownType(typeNode.name.text, typeNode.name.range, diagnostics);
    return unknownType;
  }
  if (typeNode.kind === "GenericType") {
    const name = typeNode.name.text;
    if (name === "List") {
      return {
        kind: "List",
        elementType: typeFromAnnotation(typeNode.args[0], scope, diagnostics, aliasStack),
        explicitAnnotation: true
      };
    }
    const alias = scope ? lookupTypeAliasInScope(scope, name) : undefined;
    if (alias) {
      return explicitlyAnnotated(resolveTypeAliasSymbol(alias, diagnostics, aliasStack));
    }
    const builtin = namedType(name);
    if (builtin.kind !== "Unknown") {
      return explicitlyAnnotated(builtin);
    }
    reportUnknownType(name, typeNode.name.range, diagnostics);
    return unknownType;
  }
  if (typeNode.kind === "FunctionType") {
    return {
      kind: "Function",
      parameters: typeNode.parameters.map(parameter =>
        typeFromAnnotation(parameter, scope, diagnostics, aliasStack)
      ),
      returnType: typeFromAnnotation(typeNode.returnType, scope, diagnostics, aliasStack),
      explicitAnnotation: true
    };
  }
  if (typeNode.kind === "UnionType") {
    return {
      kind: "Union",
      options: typeNode.options.map(option =>
        typeFromAnnotation(option, scope, diagnostics, aliasStack)
      ),
      explicitAnnotation: true
    };
  }
  if (typeNode.kind === "ObjectType") {
    const properties = new Map<string, RsglObjectProperty>();
    for (const property of typeNode.properties) {
      const name = property.name?.text;
      if (!name) {
        continue;
      }
      if (properties.has(name)) {
        diagnostics?.push({
          code: "rsgl.duplicateRecordField",
          message: `Duplicate record field '${name}'.`,
          severity: "error",
          range: property.name?.range ?? property.range
        });
        continue;
      }
      properties.set(name, objectProperty(
        typeFromAnnotation(property.typeAnnotation, scope, diagnostics, aliasStack),
        property.optional,
        property.name?.range ?? property.range
      ));
    }
    return { kind: "Object", properties, open: false, explicitAnnotation: true };
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
  if (node.kind === "StringLiteral") {
    return { kind: "String", literalValue: node.value };
  }
  if (node.kind === "TemplateStringExpr") {
    return stringType;
  }
  if (node.kind === "NumberLiteral") {
    return { kind: "Number", literalValue: node.value };
  }
  if (node.kind === "BooleanLiteral") {
    return { kind: "Boolean", literalValue: node.value };
  }
  if (node.kind === "NullLiteral") {
    return { kind: "Null", literalValue: null };
  }
  if (node.kind === "ResourceLocationExpr") {
    return resourceIdType;
  }
  return unknownType;
}

export function hasLiteralValue(type: RsglType): boolean {
  return Object.prototype.hasOwnProperty.call(type, "literalValue");
}

function lookupTypeAliasInScope(scope: RsglScope, name: string): RsglTypeAliasSymbol | undefined {
  let current: RsglScope | undefined = scope;
  while (current) {
    const alias = current.typeAliases.get(name);
    if (alias) {
      return alias;
    }
    current = current.parent;
  }
  return undefined;
}

export function resolveTypeAliasSymbol(
  alias: RsglTypeAliasSymbol,
  diagnostics: RsglDiagnostic[] | undefined,
  aliasStack: RsglTypeAliasSymbol[]
): RsglType {
  if (alias.state === "resolved") {
    return alias.type ?? unknownType;
  }
  if (alias.state === "resolving") {
    const cycleStart = aliasStack.indexOf(alias);
    const cycle = cycleStart >= 0 ? aliasStack.slice(cycleStart) : [alias];
    const cycleNames = [...cycle.map(item => item.name), alias.name].join(" -> ");
    const crossesScopes = new Set(cycle.map(item => item.scope)).size > 1;
    for (const item of cycle) {
      item.invalid = true;
      item.circularAcrossScopes ||= crossesScopes;
      if (!item.circularDiagnosticReported) {
        diagnostics?.push({
          code: "rsgl.circularTypeAlias",
          message: `Circular type alias '${item.name}' (${cycleNames}).`,
          severity: "error",
          range: item.node.name?.range ?? item.node.range
        });
        item.circularDiagnosticReported = true;
      }
    }
    return unknownType;
  }

  alias.state = "resolving";
  const resolved = typeFromAnnotation(
    alias.node.typeAnnotation,
    alias.scope,
    diagnostics,
    [...aliasStack, alias]
  );
  alias.type = alias.invalid ? unknownType : resolved;
  alias.state = "resolved";
  return alias.type;
}

function reportUnknownType(
  name: string,
  range: TextRange,
  diagnostics: RsglDiagnostic[] | undefined
): void {
  if (!diagnostics || diagnostics.some(diagnostic =>
    diagnostic.code === "rsgl.unknownType"
    && diagnostic.range.start === range.start
    && diagnostic.range.end === range.end
  )) {
    return;
  }
  diagnostics.push({
    code: "rsgl.unknownType",
    message: `Unknown RSGL type '${name}'.`,
    severity: "error",
    range
  });
}

export function identifierName(identifier: IdentifierNode | null | undefined): string | null {
  return identifier?.text ?? null;
}
