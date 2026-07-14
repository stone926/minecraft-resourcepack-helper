import * as path from "node:path";
import { normalizePathKey } from "../../mc-assets/src";
import {
  MemberExprNode,
  RsglModule,
  TextRange
} from "./parser";
import { walkRsglModule } from "./parser/astTraversal";
import {
  inferRsglToolingExpressionType,
  resolveVisibleRsglMemberProperties
} from "./memberTypeResolver";
import {
  RsglObjectProperty,
  RsglModuleNamespaceMember,
  RsglModuleNamespaceMemberCategory,
  RsglProgram,
  RsglSemanticModel,
  RsglSymbol,
  RsglType
} from "./semantic/types";
import {
  moduleNamespaceMembers,
  resolveModuleNamespaceExpressionMember
} from "./semantic/moduleNamespace";
import { originalRsglSymbolDefinition } from "./semantic/symbolDefinition";

type RsglMemberLanguageProgram = Pick<RsglProgram, "models">;

/** A safe, statically described field exposed by member tooling. */
export interface RsglMemberPropertyInfo {
  name: string;
  type: RsglType;
  optional: boolean;
  /** Present only for nominal module namespace members. */
  category?: RsglModuleNamespaceMemberCategory;
  /** Original exported symbol, including its signature and template metadata. */
  symbol?: RsglSymbol;
  /** Module that owns the original exported declaration. */
  sourceFile?: string;
}

/** A property occurrence selected by hover or definition lookup. */
export interface RsglMemberAccessInfo extends RsglMemberPropertyInfo {
  range: TextRange;
}

/** Offset-based source location for an annotated record field. */
export interface RsglMemberDefinitionLocation {
  fileName: string;
  range: TextRange;
}

type ResolvedMemberAccess =
  | {
      kind: "property";
      expression: MemberExprNode;
      property: ReturnType<typeof resolveVisibleRsglMemberProperties>[number];
    }
  | {
      kind: "module";
      expression: MemberExprNode;
      member: RsglModuleNamespaceMember;
    };

/**
 * Returns `undefined` outside member access and an array (possibly empty) in a
 * member context. This distinction lets callers suppress unrelated lexical
 * completions after `receiver.` without leaking symbols from other scopes.
 */
export function getRsglMemberCompletionInfo(
  program: RsglMemberLanguageProgram,
  fileName: string,
  sourceText: string,
  offset: number
): RsglMemberPropertyInfo[] | undefined {
  const model = semanticModelForMemberFile(program, fileName);
  if (!model) {
    return undefined;
  }
  const expression = memberExpressionAtOffset(model.module, sourceText, offset, true);
  if (!expression) {
    return undefined;
  }
  const receiverType = inferRsglToolingExpressionType(model, expression.object);
  if (receiverType.kind === "ModuleNamespace") {
    return moduleNamespaceMembers(receiverType).map(member => ({
      name: member.name,
      type: member.symbol.type,
      optional: false,
      category: member.category,
      symbol: member.symbol,
      sourceFile: member.sourceFile
    }));
  }
  return resolveVisibleRsglMemberProperties(receiverType).map(({ name, type, optional }) => ({
    name,
    type,
    optional
  }));
}

/** Resolves a completed `receiver.property` occurrence for hover. */
export function getRsglMemberAccessInfo(
  program: RsglMemberLanguageProgram,
  fileName: string,
  sourceText: string,
  offset: number
): RsglMemberAccessInfo | undefined {
  const resolved = resolvedMemberAccessAtOffset(program, fileName, sourceText, offset);
  if (!resolved) {
    return undefined;
  }
  if (resolved.kind === "module") {
    return {
      name: resolved.member.name,
      type: resolved.member.symbol.type,
      optional: false,
      category: resolved.member.category,
      symbol: resolved.member.symbol,
      sourceFile: resolved.member.sourceFile,
      range: resolved.expression.property.range
    };
  }
  return {
    name: resolved.property.name,
    type: resolved.property.type,
    optional: resolved.property.optional,
    range: resolved.expression.property.range
  };
}

/** Resolves an annotated member back to its original type-alias field. */
export function getRsglMemberDefinitionLocation(
  program: RsglMemberLanguageProgram,
  fileName: string,
  sourceText: string,
  offset: number
): RsglMemberDefinitionLocation | undefined {
  const resolved = resolvedMemberAccessAtOffset(program, fileName, sourceText, offset);
  if (!resolved) {
    return undefined;
  }
  if (resolved.kind === "module") {
    return originalRsglSymbolDefinition(program.models, resolved.member.symbol)
      ?? (resolved.member.symbol.range
        ? { fileName: resolved.member.sourceFile, range: resolved.member.symbol.range }
        : undefined);
  }
  const locations: RsglMemberDefinitionLocation[] = [];
  for (const declaration of resolved.property.declarations) {
    if (!declaration.declarationRange) {
      continue;
    }
    const owners = ownersOfPropertyDeclaration(program, declaration);
    for (const owner of owners) {
      locations.push({ fileName: owner.fileName, range: declaration.declarationRange });
    }
  }
  return deduplicateLocations(locations)
    .sort((left, right) => compareLocations(left, right))[0];
}

function resolvedMemberAccessAtOffset(
  program: RsglMemberLanguageProgram,
  fileName: string,
  sourceText: string,
  offset: number
): ResolvedMemberAccess | undefined {
  const model = semanticModelForMemberFile(program, fileName);
  if (!model) {
    return undefined;
  }
  const expression = memberExpressionAtOffset(model.module, sourceText, offset, false);
  if (!expression || expression.property.text.length === 0) {
    return undefined;
  }
  const moduleMember = resolveModuleNamespaceExpressionMember(model, expression)?.member;
  if (moduleMember) {
    return { kind: "module", expression, member: moduleMember };
  }
  const receiverType = inferRsglToolingExpressionType(model, expression.object);
  const property = resolveVisibleRsglMemberProperties(receiverType)
    .find(candidate => candidate.name === expression.property.text);
  return property ? { kind: "property", expression, property } : undefined;
}

function memberExpressionAtOffset(
  module: RsglModule,
  sourceText: string,
  offset: number,
  allowPrefix: boolean
): MemberExprNode | undefined {
  const matches: MemberExprNode[] = [];
  walkRsglModule(module, {
    enterExpression(expression) {
      if (expression.kind !== "MemberExpr") {
        return;
      }
      const propertyTouched = touchesRange(expression.property.range, offset);
      const prefixTouched = allowPrefix && isMemberPrefixCursor(expression, sourceText, offset);
      if (propertyTouched || prefixTouched) {
        matches.push(expression);
      }
    }
  });
  return matches.sort((left, right) => rangeLength(left.range) - rangeLength(right.range))[0];
}

function isMemberPrefixCursor(
  expression: MemberExprNode,
  sourceText: string,
  offset: number
): boolean {
  if (offset < expression.object.range.end || offset > sourceText.length) {
    return false;
  }
  return /^\s*\.[A-Za-z0-9_]*$/.test(sourceText.slice(expression.object.range.end, offset));
}

function ownersOfPropertyDeclaration(
  program: RsglMemberLanguageProgram,
  property: RsglObjectProperty
): RsglSemanticModel[] {
  const exact = program.models.filter(model => model.module.statements.some(statement => {
    if (statement.kind !== "TypeAliasDecl" || !statement.name) {
      return false;
    }
    const alias = model.scope.typeAliases.get(statement.name.text);
    return alias?.node === statement && typeContainsProperty(alias.type, property, new Set());
  }));
  if (exact.length > 0 || !property.declarationRange) {
    return exact;
  }
  return program.models.filter(model => model.module.statements.some(statement =>
    statement.kind === "TypeAliasDecl"
    && statement.range.start <= property.declarationRange!.start
    && property.declarationRange!.end <= statement.range.end
  ));
}

function typeContainsProperty(
  type: RsglType | undefined,
  target: RsglObjectProperty,
  visited: Set<RsglType>
): boolean {
  if (!type || visited.has(type)) {
    return false;
  }
  visited.add(type);
  for (const property of type.properties?.values() ?? []) {
    if (property === target || typeContainsProperty(property.type, target, visited)) {
      return true;
    }
  }
  if (type.elementType && typeContainsProperty(type.elementType, target, visited)) {
    return true;
  }
  if (type.returnType && typeContainsProperty(type.returnType, target, visited)) {
    return true;
  }
  return [
    ...(type.options ?? []),
    ...(type.parameters ?? [])
  ].some(child => typeContainsProperty(child, target, visited));
}

function semanticModelForMemberFile(
  program: RsglMemberLanguageProgram,
  fileName: string
): RsglSemanticModel | undefined {
  const key = normalizePathKey(path.resolve(fileName));
  return program.models.find(model => normalizePathKey(path.resolve(model.fileName)) === key);
}

function deduplicateLocations(
  locations: readonly RsglMemberDefinitionLocation[]
): RsglMemberDefinitionLocation[] {
  return [...new Map(locations.map(location => [
    `${normalizePathKey(path.resolve(location.fileName))}:${location.range.start}:${location.range.end}`,
    location
  ])).values()];
}

function compareLocations(
  left: RsglMemberDefinitionLocation,
  right: RsglMemberDefinitionLocation
): number {
  return normalizePathKey(path.resolve(left.fileName)).localeCompare(normalizePathKey(path.resolve(right.fileName)))
    || left.range.start - right.range.start;
}

function touchesRange(range: TextRange, offset: number): boolean {
  return range.start <= offset && offset <= range.end;
}

function rangeLength(range: TextRange): number {
  return range.end - range.start;
}
