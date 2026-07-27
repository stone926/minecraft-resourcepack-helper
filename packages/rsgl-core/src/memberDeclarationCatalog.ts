import { resolveRsglPath, rsglPathKey } from "./pathIdentity";
import type { TextRange, TypeNode } from "./parser";
import { touchesRange } from "./textRangeQueries";
import type {
  RsglObjectProperty,
  RsglProgram,
  RsglType
} from "./semantic/types";

export type RsglMemberDeclarationProgram = Pick<RsglProgram, "models">;

/** Offset-based source location for an annotated record field. */
export interface RsglMemberDefinitionLocation {
  fileName: string;
  range: TextRange;
}

interface RsglMemberDeclarationRecord extends RsglMemberDefinitionLocation {
  name: string;
}

export interface RsglMemberDeclarationCatalog {
  records: RsglMemberDeclarationRecord[];
  locationsByProperty: Map<RsglObjectProperty, RsglMemberDefinitionLocation[]>;
  locationsByOwnerNameAndRange: Map<string, RsglMemberDefinitionLocation[]>;
  ownerFileKeysByDeclarationRange: Map<TextRange, Set<string>>;
  ownerFileKeysByNameAndRange: Map<string, Set<string>>;
}

const memberDeclarationCatalogs = new WeakMap<object, RsglMemberDeclarationCatalog>();

/** Builds and caches structural field declaration identity for one linked program. */
export function createMemberDeclarationCatalog(
  program: RsglMemberDeclarationProgram
): RsglMemberDeclarationCatalog {
  const cached = memberDeclarationCatalogs.get(program);
  if (cached) {
    return cached;
  }
  const catalog: RsglMemberDeclarationCatalog = {
    records: [],
    locationsByProperty: new Map(),
    locationsByOwnerNameAndRange: new Map(),
    ownerFileKeysByDeclarationRange: new Map(),
    ownerFileKeysByNameAndRange: new Map()
  };
  for (const model of program.models) {
    for (const statement of model.module.statements) {
      if (statement.kind !== "TypeAliasDecl" || !statement.name) {
        continue;
      }
      const statementRecords: RsglMemberDeclarationRecord[] = [];
      collectTypePropertyDeclarations(statement.typeAnnotation, model.fileName, statementRecords);
      for (const record of statementRecords) {
        catalog.records.push(record);
        const location = { fileName: record.fileName, range: record.range };
        const ownerFileKey = memberOwnerFileKey(record.fileName);
        appendLocation(
          catalog.locationsByOwnerNameAndRange,
          memberPropertyOwnerRangeKey(ownerFileKey, record.name, record.range),
          location
        );
        appendSetValue(catalog.ownerFileKeysByDeclarationRange, record.range, ownerFileKey);
        appendSetValue(
          catalog.ownerFileKeysByNameAndRange,
          memberPropertyNameRangeKey(record.name, record.range),
          ownerFileKey
        );
      }

      const alias = model.scope.typeAliases.get(statement.name.text);
      if (alias?.node !== statement) {
        continue;
      }
      const recordByKey = new Map(statementRecords.map(record => [
        memberPropertyNameRangeKey(record.name, record.range),
        record
      ]));
      forEachSemanticTypeProperty(alias.type, (name, property) => {
        if (!property.declarationRange) {
          return;
        }
        const record = recordByKey.get(
          memberPropertyNameRangeKey(name, property.declarationRange)
        );
        if (record) {
          appendLocation(catalog.locationsByProperty, property, {
            fileName: record.fileName,
            range: record.range
          });
        }
      });
    }
  }
  memberDeclarationCatalogs.set(program, catalog);
  return catalog;
}

export function locationsOfMemberProperty(
  catalog: RsglMemberDeclarationCatalog,
  name: string,
  declarations: readonly RsglObjectProperty[]
): RsglMemberDefinitionLocation[] {
  const locations: RsglMemberDefinitionLocation[] = [];
  for (const declaration of declarations) {
    const exact = catalog.locationsByProperty.get(declaration);
    if (exact) {
      locations.push(...exact);
      continue;
    }
    if (declaration.declarationRange) {
      const ownerFileKeys = fallbackOwnerFileKeys(catalog, name, declaration.declarationRange);
      for (const ownerFileKey of ownerFileKeys) {
        locations.push(...(
          catalog.locationsByOwnerNameAndRange.get(
            memberPropertyOwnerRangeKey(ownerFileKey, name, declaration.declarationRange)
          ) ?? []
        ));
      }
    }
  }
  return deduplicateMemberLocations(locations);
}

export function memberDeclarationLocationsAtOffset(
  catalog: RsglMemberDeclarationCatalog,
  fileName: string,
  offset: number
): RsglMemberDefinitionLocation[] {
  const fileKey = rsglPathKey(resolveRsglPath(fileName));
  return catalog.records
    .filter(record =>
      rsglPathKey(resolveRsglPath(record.fileName)) === fileKey
      && touchesRange(record.range, offset)
    )
    .map(({ fileName: ownerFileName, range }) => ({ fileName: ownerFileName, range }));
}

export function rsglMemberLocationKey(location: RsglMemberDefinitionLocation): string {
  return `${rsglPathKey(resolveRsglPath(location.fileName))}\0${location.range.start}\0${location.range.end}`;
}

export function deduplicateMemberLocations(
  locations: readonly RsglMemberDefinitionLocation[]
): RsglMemberDefinitionLocation[] {
  return [...new Map(locations.map(location => [rsglMemberLocationKey(location), location])).values()];
}

export function compareMemberLocations(
  left: RsglMemberDefinitionLocation,
  right: RsglMemberDefinitionLocation
): number {
  return rsglPathKey(resolveRsglPath(left.fileName)).localeCompare(
    rsglPathKey(resolveRsglPath(right.fileName))
  ) || left.range.start - right.range.start;
}

function collectTypePropertyDeclarations(
  type: TypeNode,
  fileName: string,
  records: RsglMemberDeclarationRecord[]
): void {
  if (type.kind === "GenericType") {
    type.args.forEach(argument => collectTypePropertyDeclarations(argument, fileName, records));
    return;
  }
  if (type.kind === "FunctionType") {
    type.parameters.forEach(parameter =>
      collectTypePropertyDeclarations(parameter, fileName, records)
    );
    collectTypePropertyDeclarations(type.returnType, fileName, records);
    return;
  }
  if (type.kind === "UnionType") {
    type.options.forEach(option => collectTypePropertyDeclarations(option, fileName, records));
    return;
  }
  if (type.kind !== "ObjectType") {
    return;
  }
  for (const property of type.properties) {
    if (property.name) {
      records.push({
        name: property.name.text,
        fileName,
        range: property.name.range
      });
    }
    collectTypePropertyDeclarations(property.typeAnnotation, fileName, records);
  }
}

function forEachSemanticTypeProperty(
  root: RsglType | undefined,
  visit: (name: string, property: RsglObjectProperty) => void
): void {
  const visited = new Set<RsglType>();
  const visitType = (type: RsglType | undefined): void => {
    if (!type || visited.has(type)) {
      return;
    }
    visited.add(type);
    for (const [name, property] of type.properties ?? []) {
      visit(name, property);
      visitType(property.type);
    }
    visitType(type.elementType);
    visitType(type.indexType);
    visitType(type.returnType);
    type.options?.forEach(visitType);
    type.parameters?.forEach(visitType);
  };
  visitType(root);
}

function appendLocation<TKey>(
  locationsByKey: Map<TKey, RsglMemberDefinitionLocation[]>,
  key: TKey,
  location: RsglMemberDefinitionLocation
): void {
  const locations = locationsByKey.get(key) ?? [];
  locations.push(location);
  locationsByKey.set(key, locations);
}

function appendSetValue<TKey, TValue>(
  valuesByKey: Map<TKey, Set<TValue>>,
  key: TKey,
  value: TValue
): void {
  const values = valuesByKey.get(key) ?? new Set<TValue>();
  values.add(value);
  valuesByKey.set(key, values);
}

function fallbackOwnerFileKeys(
  catalog: RsglMemberDeclarationCatalog,
  name: string,
  range: TextRange
): readonly string[] {
  const identityOwners = catalog.ownerFileKeysByDeclarationRange.get(range);
  if (identityOwners?.size) {
    return [...identityOwners];
  }
  const valueOwners = catalog.ownerFileKeysByNameAndRange.get(
    memberPropertyNameRangeKey(name, range)
  );
  return valueOwners?.size === 1 ? [...valueOwners] : [];
}

function memberPropertyNameRangeKey(name: string, range: TextRange): string {
  return `${name}\0${range.start}\0${range.end}`;
}

function memberPropertyOwnerRangeKey(
  ownerFileKey: string,
  name: string,
  range: TextRange
): string {
  return `${ownerFileKey}\0${memberPropertyNameRangeKey(name, range)}`;
}

function memberOwnerFileKey(fileName: string): string {
  return rsglPathKey(resolveRsglPath(fileName));
}
