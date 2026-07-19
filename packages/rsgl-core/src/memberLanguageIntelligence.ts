import { resolveRsglPath, rsglPathKey } from "./pathIdentity";
import {
  MemberExprNode,
  ObjectExprNode,
  RsglModule,
  TextRange
} from "./parser";
import { walkRsglModule } from "./parser/astTraversal";
import {
  inferRsglToolingExpressionType,
  resolveVisibleRsglMemberProperties
} from "./memberTypeResolver";
import {
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
import { objectKeyName } from "./semantic/contextualObjectChecking";
import { originalRsglSymbolDefinition } from "./semantic/symbolDefinition";
import {
  compareMemberLocations,
  createMemberDeclarationCatalog,
  deduplicateMemberLocations,
  locationsOfMemberProperty,
  memberDeclarationLocationsAtOffset,
  rsglMemberLocationKey,
  type RsglMemberDefinitionLocation
} from "./memberDeclarationCatalog";

export type { RsglMemberDefinitionLocation } from "./memberDeclarationCatalog";

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

type ResolvedStructuralMemberProperty =
  ReturnType<typeof resolveVisibleRsglMemberProperties>[number];

interface ResolvedObjectPropertyOccurrence {
  range: TextRange;
  property: ResolvedStructuralMemberProperty;
}

type ResolvedMemberAccess =
  | {
      kind: "property";
      expression: MemberExprNode;
      property: ResolvedStructuralMemberProperty;
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
  if (resolved?.kind === "module") {
    return originalRsglSymbolDefinition(program.models, resolved.member.symbol)
      ?? (resolved.member.symbol.range
        ? { fileName: resolved.member.sourceFile, range: resolved.member.symbol.range }
        : undefined);
  }
  const model = semanticModelForMemberFile(program, fileName);
  const objectProperty = !resolved && model
    ? contextualObjectPropertyAtOffset(model, offset)
    : undefined;
  const structuralProperty = resolved?.kind === "property"
    ? resolved.property
    : objectProperty?.property;
  if (!structuralProperty) {
    if (!model?.module.statements.some(statement =>
      statement.kind === "TypeAliasDecl"
      && touchesRange(statement.typeAnnotation.range, offset)
    )) {
      return undefined;
    }
    const catalog = createMemberDeclarationCatalog(program);
    return memberDeclarationLocationsAtOffset(catalog, fileName, offset)
      .sort((left, right) => compareMemberLocations(left, right))[0];
  }
  const catalog = createMemberDeclarationCatalog(program);
  const locations = locationsOfMemberProperty(
    catalog,
    structuralProperty.name,
    structuralProperty.declarations
  );
  return deduplicateMemberLocations(locations)
    .sort((left, right) => compareMemberLocations(left, right))[0];
}

/** Finds declaration-linked structural field occurrences across a linked program. */
export function getRsglMemberReferenceLocations(
  program: RsglMemberLanguageProgram,
  fileName: string,
  offset: number,
  includeDeclaration: boolean
): RsglMemberDefinitionLocation[] | undefined {
  const model = semanticModelForMemberFile(program, fileName);
  if (!model) {
    return undefined;
  }
  const resolved = resolvedMemberAccessAtOffset(program, fileName, "", offset);
  if (resolved?.kind === "module") {
    return undefined;
  }

  const catalog = createMemberDeclarationCatalog(program);
  let targetLocations = resolved
    ? locationsOfMemberProperty(catalog, resolved.property.name, resolved.property.declarations)
    : memberDeclarationLocationsAtOffset(catalog, model.fileName, offset);
  if (!resolved && targetLocations.length === 0) {
    const objectProperty = contextualObjectPropertyAtOffset(model, offset);
    if (objectProperty) {
      targetLocations = locationsOfMemberProperty(
        catalog,
        objectProperty.property.name,
        objectProperty.property.declarations
      );
    }
  }
  if (targetLocations.length === 0) {
    return undefined;
  }

  const targetKeys = new Set(targetLocations.map(rsglMemberLocationKey));
  const locations = includeDeclaration ? [...targetLocations] : [];
  for (const owner of program.models) {
    walkRsglModule(owner.module, {
      enterExpression(expression) {
        if (expression.kind !== "MemberExpr") {
          if (expression.kind === "ObjectExpr") {
            for (const occurrence of contextualObjectPropertyOccurrences(owner, expression)) {
              const definitions = locationsOfMemberProperty(
                catalog,
                occurrence.property.name,
                occurrence.property.declarations
              );
              if (definitions.some(location => targetKeys.has(rsglMemberLocationKey(location)))) {
                locations.push({ fileName: owner.fileName, range: occurrence.range });
              }
            }
          }
          return;
        }
        const candidate = resolveMemberAccess(owner, expression);
        if (candidate?.kind !== "property") {
          return;
        }
        const definitions = locationsOfMemberProperty(
          catalog,
          candidate.property.name,
          candidate.property.declarations
        );
        if (definitions.some(location => targetKeys.has(rsglMemberLocationKey(location)))) {
          locations.push({ fileName: owner.fileName, range: expression.property.range });
        }
      }
    });
  }
  return deduplicateMemberLocations(locations)
    .sort((left, right) => compareMemberLocations(left, right));
}

function contextualObjectPropertyAtOffset(
  model: RsglSemanticModel,
  offset: number
): ResolvedObjectPropertyOccurrence | undefined {
  const matches: ResolvedObjectPropertyOccurrence[] = [];
  walkRsglModule(model.module, {
    enterExpression(expression) {
      if (expression.kind !== "ObjectExpr") {
        return;
      }
      matches.push(...contextualObjectPropertyOccurrences(model, expression)
        .filter(occurrence => touchesRange(occurrence.range, offset)));
    }
  });
  return matches.sort((left, right) => rangeLength(left.range) - rangeLength(right.range))[0];
}

function contextualObjectPropertyOccurrences(
  model: RsglSemanticModel,
  expression: ObjectExprNode
): ResolvedObjectPropertyOccurrence[] {
  const expectedType = model.resolvedExpectedTypes.get(expression);
  if (!expectedType) {
    return [];
  }
  const properties = new Map(
    resolveVisibleRsglMemberProperties(expectedType).map(property => [property.name, property])
  );
  const occurrences: ResolvedObjectPropertyOccurrence[] = [];
  for (const entry of expression.properties) {
    if (entry.kind !== "ObjectProperty") {
      continue;
    }
    const name = objectKeyName(entry);
    const property = name === null ? undefined : properties.get(name);
    if (property) {
      occurrences.push({ range: entry.key.range, property });
    }
  }
  return occurrences;
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
  return resolveMemberAccess(model, expression);
}

function resolveMemberAccess(
  model: RsglSemanticModel,
  expression: MemberExprNode
): ResolvedMemberAccess | undefined {
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

function semanticModelForMemberFile(
  program: RsglMemberLanguageProgram,
  fileName: string
): RsglSemanticModel | undefined {
  const key = rsglPathKey(resolveRsglPath(fileName));
  return program.models.find(model => rsglPathKey(resolveRsglPath(model.fileName)) === key);
}

function touchesRange(range: TextRange, offset: number): boolean {
  return range.start <= offset && offset <= range.end;
}

function rangeLength(range: TextRange): number {
  return range.end - range.start;
}
