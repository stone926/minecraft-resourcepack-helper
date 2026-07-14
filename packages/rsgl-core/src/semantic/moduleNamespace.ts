import type { ExprNode, MemberExprNode } from "../parser";
import { resolvedTemplateOutputMetadata } from "../templateOutput";
import { diagnostic } from "./diagnostics";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { lookup } from "./scopes";
import type {
  RsglModuleNamespaceMember,
  RsglModuleNamespaceMemberCategory,
  RsglScope,
  RsglSemanticModel,
  RsglSymbol,
  RsglType
} from "./types";

export interface CreateModuleNamespaceTypeOptions {
  sourceFileForSymbol?: (symbol: RsglSymbol) => string | undefined;
}

/** Creates the nominal, non-JSON view exposed by `import * as name`. */
export function createModuleNamespaceType(
  moduleId: string,
  exports: ReadonlyMap<string, RsglSymbol> = new Map(),
  options: CreateModuleNamespaceTypeOptions = {}
): RsglType {
  const members = new Map<string, RsglModuleNamespaceMember>();
  for (const [name, symbol] of exports) {
    const category = moduleExportMemberCategory(symbol);
    if (!category) {
      continue;
    }
    members.set(name, {
      name,
      category,
      symbol,
      sourceFile: options.sourceFileForSymbol?.(symbol) ?? moduleId
    });
  }
  return {
    kind: "ModuleNamespace",
    moduleNamespaceId: moduleId,
    moduleNamespaceMembers: members
  };
}

/** Returns linked members in deterministic export-map order. */
export function moduleNamespaceMembers(type: RsglType): readonly RsglModuleNamespaceMember[] {
  return type.kind === "ModuleNamespace"
    ? Array.from(type.moduleNamespaceMembers?.values() ?? [])
    : [];
}

export function resolveModuleNamespaceMember(
  type: RsglType,
  name: string
): RsglModuleNamespaceMember | undefined {
  return type.kind === "ModuleNamespace"
    ? type.moduleNamespaceMembers?.get(name)
    : undefined;
}

export interface CheckedModuleNamespaceMember {
  /** True whenever the receiver was a module namespace, including recovery. */
  handled: true;
  member?: RsglModuleNamespaceMember;
}

/** Shared checker for ordinary member access, calls, and `use` calls. */
export function checkModuleNamespaceMember(
  context: RsglExpressionCheckContext,
  expression: MemberExprNode,
  objectType: RsglType,
  expectedCategory: RsglModuleNamespaceMemberCategory
): CheckedModuleNamespaceMember | undefined {
  if (objectType.kind !== "ModuleNamespace") {
    return undefined;
  }
  const member = resolveModuleNamespaceMember(objectType, expression.property.text);
  if (!member) {
    context.diagnostics.push(diagnostic(
      "rsgl.missingImportedMember",
      `Module '${objectType.moduleNamespaceId ?? "<unknown>"}' does not export '${expression.property.text}'.`,
      expression.property.range
    ));
    context.recordResolvedExpressionType?.(expression, { kind: "Unknown" });
    return { handled: true };
  }
  context.references.push({
    name: expression.property.text,
    range: expression.property.range,
    symbol: member.symbol
  });
  context.recordResolvedExpressionType?.(expression, member.symbol.type);
  if (member.category !== expectedCategory) {
    const expected = expectedCategory === "template" ? "a template" : "a value";
    context.diagnostics.push(diagnostic(
      "rsgl.invalidImportedMemberKind",
      `Imported member '${expression.property.text}' is ${member.category === "template" ? "a template" : "a value"}; this context requires ${expected}.`,
      expression.property.range
    ));
  }
  return { handled: true, member };
}

/**
 * Values and templates share one export namespace. A Function-valued lambda
 * stays a value; only frozen template-output metadata establishes template
 * membership.
 */
export function moduleExportMemberCategory(
  symbol: RsglSymbol
): RsglModuleNamespaceMemberCategory | undefined {
  if (resolvedTemplateOutputMetadata(symbol)) {
    return "template";
  }
  if (
    symbol.kind === "builtin"
    || symbol.kind === "namespace"
    || symbol.kind === "resource"
    || symbol.kind === "template"
    || symbol.type.kind === "ModuleNamespace"
  ) {
    return undefined;
  }
  return "value";
}

export interface ResolvedModuleNamespaceExpressionMember {
  namespaceSymbol?: RsglSymbol;
  member: RsglModuleNamespaceMember;
}

/** Resolves a qualified member from its lexical scope without rebuilding exports. */
export function resolveModuleNamespaceMemberInScope(
  scope: RsglScope,
  expression: MemberExprNode
): ResolvedModuleNamespaceExpressionMember | undefined {
  const namespaceSymbol = namespaceSymbolForExpression(scope, expression.object);
  const member = namespaceSymbol
    ? resolveModuleNamespaceMember(namespaceSymbol.type, expression.property.text)
    : undefined;
  return member ? { namespaceSymbol, member } : undefined;
}

/** Stable tooling entry point using the symbol references retained by a model. */
export function resolveModuleNamespaceExpressionMember(
  model: RsglSemanticModel,
  expression: MemberExprNode
): ResolvedModuleNamespaceExpressionMember | undefined {
  if (expression.object.kind !== "IdentifierExpr") {
    return undefined;
  }
  const object = expression.object;
  const reference = model.references.find(candidate =>
    candidate.range.start === object.range.start
    && candidate.range.end === object.range.end
    && candidate.name === object.name.text
  );
  const namespaceSymbol = reference?.symbol ?? model.scope.symbols.get(object.name.text);
  const member = namespaceSymbol
    ? resolveModuleNamespaceMember(namespaceSymbol.type, expression.property.text)
    : undefined;
  return member ? { namespaceSymbol, member } : undefined;
}

export function namespaceSymbolForExpression(
  scope: RsglScope,
  expression: ExprNode
): RsglSymbol | undefined {
  if (expression.kind !== "IdentifierExpr") {
    return undefined;
  }
  const symbol = lookup(scope, expression.name.text);
  return symbol?.kind === "namespace" && symbol.type.kind === "ModuleNamespace"
    ? symbol
    : undefined;
}

/** Resolves the only callable symbol shapes supported by semantic linking. */
export function resolveCallableSymbolInScope(
  scope: RsglScope,
  expression: ExprNode
): RsglSymbol | undefined {
  if (expression.kind === "IdentifierExpr") {
    return lookup(scope, expression.name.text);
  }
  if (expression.kind === "MemberExpr") {
    return resolveModuleNamespaceMemberInScope(scope, expression)?.member.symbol;
  }
  return undefined;
}

export function callableExpressionName(expression: ExprNode): string | undefined {
  if (expression.kind === "IdentifierExpr") {
    return expression.name.text;
  }
  if (expression.kind === "MemberExpr" && expression.object.kind === "IdentifierExpr") {
    return `${expression.object.name.text}.${expression.property.text}`;
  }
  return undefined;
}
