import * as fs from "node:fs";
import * as path from "node:path";
import { resolveBundledCitAssetRoot } from "./citAssetRoot";

export interface CitBuiltinResourceCatalog {
  schemaVersion: 1;
  defaultNamespace: string;
  items: string[];
  enchantments: string[];
  armorSuffixes: string[];
}

export function loadCitBuiltinResourceCatalog(
  assetRoot = resolveBundledCitAssetRoot()
): CitBuiltinResourceCatalog {
  const fileName = path.join(assetRoot, "builtin-resource-ids.json");
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(fileName, "utf8"));
  } catch (error) {
    throw new Error(`Unable to load CIT builtin resource catalog '${fileName}'.`, { cause: error });
  }
  return validateCatalog(value, fileName);
}

function validateCatalog(value: unknown, fileName: string): CitBuiltinResourceCatalog {
  const record = requireRecord(value, fileName);
  if (record.schemaVersion !== 1) {
    throw new Error(`${fileName}: schemaVersion must be 1.`);
  }

  const defaultNamespace = requireResourceNamespace(
    record.defaultNamespace,
    "defaultNamespace",
    fileName
  );
  const items = requireResourcePaths(record.items, "items", fileName)
    .map(id => `${defaultNamespace}:${id}`);
  const enchantments = requireResourcePaths(record.enchantments, "enchantments", fileName)
    .map(id => `${defaultNamespace}:${id}`);
  const armorSuffixes = requireUniqueStrings(record.armorSuffixes, "armorSuffixes", fileName);
  for (const suffix of armorSuffixes) {
    if (!/^_[a-z0-9_.-]+$/.test(suffix)) {
      throw new Error(`${fileName}: armorSuffixes contains invalid suffix '${suffix}'.`);
    }
  }

  return {
    schemaVersion: 1,
    defaultNamespace,
    items,
    enchantments,
    armorSuffixes
  };
}

function requireRecord(value: unknown, fileName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fileName}: catalog root must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireResourceNamespace(value: unknown, key: string, fileName: string): string {
  if (typeof value !== "string" || !/^[a-z0-9_.-]+$/.test(value)) {
    throw new Error(`${fileName}: ${key} must be a valid resource namespace.`);
  }
  return value;
}

function requireResourcePaths(value: unknown, key: string, fileName: string): string[] {
  const paths = requireUniqueStrings(value, key, fileName);
  for (const resourcePath of paths) {
    if (!/^[a-z0-9_./-]+$/.test(resourcePath)) {
      throw new Error(`${fileName}: ${key} contains invalid resource path '${resourcePath}'.`);
    }
  }
  return paths;
}

function requireUniqueStrings(value: unknown, key: string, fileName: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${fileName}: ${key} must be an array of non-empty strings.`);
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) {
    throw new Error(`${fileName}: ${key} must not contain duplicate values.`);
  }
  return [...strings];
}
