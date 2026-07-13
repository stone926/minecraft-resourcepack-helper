import type { RsglDiagnostic, TopLevelStatementNode, TypeAliasDeclNode } from "../parser";
import { resolveTypeAliasSymbol, type RsglScope, type RsglTypeAliasSymbol } from "./types";

const builtinTypeNames = new Set([
  "Any",
  "Boolean",
  "Function",
  "Json",
  "List",
  "ModelId",
  "Null",
  "Number",
  "Path",
  "Range",
  "ResourceId",
  "String",
  "TextureId",
  "TextureRef",
  "TextureVariable"
]);

export function predeclareTypeAliases(
  statements: readonly TopLevelStatementNode[],
  scope: RsglScope,
  diagnostics: RsglDiagnostic[]
): void {
  for (const statement of statements) {
    if (statement.kind === "TypeAliasDecl") {
      defineTypeAlias(statement, scope, diagnostics);
    }
  }
}

export function resolveTypeAliases(scope: RsglScope, diagnostics: RsglDiagnostic[]): void {
  for (const alias of scope.typeAliases.values()) {
    if (alias.state === "unresolved") {
      resolveTypeAliasSymbol(alias, diagnostics, []);
    }
  }
}

export function installPrelinkedTypeAliases(
  scope: RsglScope,
  aliases: ReadonlyMap<string, RsglTypeAliasSymbol> | undefined
): void {
  if (!aliases) {
    return;
  }
  for (const [localName, alias] of aliases) {
    if (!scope.typeAliases.has(localName)) {
      scope.typeAliases.set(localName, alias);
    }
  }
}

export function defineResolvedTypeAlias(
  scope: RsglScope,
  localName: string,
  source: RsglTypeAliasSymbol
): void {
  scope.typeAliases.set(localName, {
    ...source,
    name: localName,
    scope,
    state: "resolved"
  });
}

function defineTypeAlias(
  statement: TypeAliasDeclNode,
  scope: RsglScope,
  diagnostics: RsglDiagnostic[]
): void {
  const name = statement.name?.text;
  if (!name) {
    return;
  }
  if (builtinTypeNames.has(name) || scope.typeAliases.has(name)) {
    diagnostics.push({
      code: "rsgl.duplicateTypeAlias",
      message: `Duplicate type alias '${name}' in the type namespace.`,
      severity: "error",
      range: statement.name?.range ?? statement.range
    });
    return;
  }
  scope.typeAliases.set(name, {
    name,
    node: statement,
    scope,
    state: "unresolved"
  });
}
