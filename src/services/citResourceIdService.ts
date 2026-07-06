import * as path from "node:path";
import { normalizePathKey, packRootFromAssetsPath } from "../../packages/mc-assets/src";
import { workspaceResourceCache } from "./workspaceResourceCache";

export interface CitResourceIdConfiguration {
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
}

export interface CitResourceIds {
  items: string[];
  enchantments: string[];
}

interface CachedResourceIds {
  cacheKey: string;
  generation: number;
  configurationVersion: number;
  ids: CitResourceIds;
}

const builtinEnchantments = [
  "aqua_affinity",
  "bane_of_arthropods",
  "binding_curse",
  "blast_protection",
  "breach",
  "channeling",
  "density",
  "depth_strider",
  "efficiency",
  "feather_falling",
  "fire_aspect",
  "fire_protection",
  "flame",
  "fortune",
  "frost_walker",
  "impaling",
  "infinity",
  "knockback",
  "looting",
  "loyalty",
  "luck_of_the_sea",
  "lure",
  "mending",
  "multishot",
  "piercing",
  "power",
  "projectile_protection",
  "protection",
  "punch",
  "quick_charge",
  "respiration",
  "riptide",
  "sharpness",
  "silk_touch",
  "smite",
  "soul_speed",
  "sweeping_edge",
  "swift_sneak",
  "thorns",
  "unbreaking",
  "vanishing_curse",
  "wind_burst"
].map(id => `minecraft:${id}`);

const builtinItemIds = [
  "air",
  "apple",
  "arrow",
  "baked_potato",
  "beef",
  "blaze_powder",
  "blaze_rod",
  "bow",
  "bread",
  "brush",
  "bucket",
  "carrot",
  "coal",
  "compass",
  "crossbow",
  "diamond",
  "diamond_axe",
  "diamond_boots",
  "diamond_chestplate",
  "diamond_helmet",
  "diamond_hoe",
  "diamond_leggings",
  "diamond_pickaxe",
  "diamond_shovel",
  "diamond_sword",
  "egg",
  "elytra",
  "emerald",
  "enchanted_book",
  "ender_pearl",
  "fishing_rod",
  "flint_and_steel",
  "gold_ingot",
  "golden_apple",
  "golden_axe",
  "golden_boots",
  "golden_carrot",
  "golden_chestplate",
  "golden_helmet",
  "golden_hoe",
  "golden_leggings",
  "golden_pickaxe",
  "golden_shovel",
  "golden_sword",
  "iron_axe",
  "iron_boots",
  "iron_chestplate",
  "iron_helmet",
  "iron_hoe",
  "iron_ingot",
  "iron_leggings",
  "iron_pickaxe",
  "iron_shovel",
  "iron_sword",
  "leather",
  "leather_boots",
  "leather_chestplate",
  "leather_helmet",
  "leather_leggings",
  "mace",
  "map",
  "milk_bucket",
  "name_tag",
  "netherite_axe",
  "netherite_boots",
  "netherite_chestplate",
  "netherite_helmet",
  "netherite_hoe",
  "netherite_ingot",
  "netherite_leggings",
  "netherite_pickaxe",
  "netherite_shovel",
  "netherite_sword",
  "potion",
  "shield",
  "snowball",
  "splash_potion",
  "stick",
  "stone_axe",
  "stone_hoe",
  "stone_pickaxe",
  "stone_shovel",
  "stone_sword",
  "tipped_arrow",
  "totem_of_undying",
  "trident",
  "turtle_helmet",
  "water_bucket",
  "wooden_axe",
  "wooden_hoe",
  "wooden_pickaxe",
  "wooden_shovel",
  "wooden_sword",
  "writable_book",
  "written_book"
].map(id => `minecraft:${id}`);

const builtinArmorItems = new Set([
  "minecraft:leather_helmet",
  "minecraft:leather_chestplate",
  "minecraft:leather_leggings",
  "minecraft:leather_boots",
  "minecraft:chainmail_helmet",
  "minecraft:chainmail_chestplate",
  "minecraft:chainmail_leggings",
  "minecraft:chainmail_boots",
  "minecraft:iron_helmet",
  "minecraft:iron_chestplate",
  "minecraft:iron_leggings",
  "minecraft:iron_boots",
  "minecraft:golden_helmet",
  "minecraft:golden_chestplate",
  "minecraft:golden_leggings",
  "minecraft:golden_boots",
  "minecraft:diamond_helmet",
  "minecraft:diamond_chestplate",
  "minecraft:diamond_leggings",
  "minecraft:diamond_boots",
  "minecraft:netherite_helmet",
  "minecraft:netherite_chestplate",
  "minecraft:netherite_leggings",
  "minecraft:netherite_boots",
  "minecraft:turtle_helmet"
]);

class CitResourceIdService {
  private cached: CachedResourceIds | null = null;

  getResourceIds(documentFileName: string, configuration: CitResourceIdConfiguration = {}): CitResourceIds {
    const cacheKey = getCacheKey(documentFileName, configuration);
    const generation = workspaceResourceCache.getResourceFsGeneration();
    const configurationVersion = workspaceResourceCache.getConfigurationVersion();
    if (
      this.cached &&
      this.cached.cacheKey === cacheKey &&
      this.cached.generation === generation &&
      this.cached.configurationVersion === configurationVersion
    ) {
      return this.cached.ids;
    }

    const ids = collectResourceIds(documentFileName, configuration);
    this.cached = { cacheKey, generation, configurationVersion, ids };
    return ids;
  }

  normalizeItemId(value: string): string {
    return normalizeResourceId(value);
  }

  normalizeEnchantmentId(value: string): string {
    return normalizeResourceId(value);
  }

  isArmorItem(value: string): boolean {
    const id = normalizeResourceId(value);
    if (builtinArmorItems.has(id)) {
      return true;
    }
    if (id === "minecraft:elytra") {
      return false;
    }
    return /_(?:helmet|chestplate|leggings|boots)$/.test(id);
  }
}

export const citResourceIdService = new CitResourceIdService();

function collectResourceIds(documentFileName: string, configuration: CitResourceIdConfiguration): CitResourceIds {
  const items = new Set(builtinItemIds);
  const enchantments = new Set(builtinEnchantments);
  const roots = getAssetsRoots(documentFileName, configuration);

  for (const assetsRoot of roots) {
    collectAssetJsonIds(assetsRoot, ["items"], items);
    collectAssetJsonIds(assetsRoot, ["models", "item"], items);
    collectDataJsonIds(path.dirname(assetsRoot), ["enchantment"], enchantments);
    collectDataJsonIds(path.dirname(assetsRoot), ["enchantments"], enchantments);
  }

  return {
    items: [...items].sort(),
    enchantments: [...enchantments].sort()
  };
}

function collectAssetJsonIds(assetsRoot: string, directorySegments: string[], target: Set<string>): void {
  const namespaces = workspaceResourceCache.getDirectoryEntriesSync(assetsRoot) ?? [];
  for (const namespace of namespaces) {
    if (!namespace.isDirectory()) {
      continue;
    }
    collectJsonIds(path.join(assetsRoot, namespace.name, ...directorySegments), namespace.name, "", target);
  }
}

function collectDataJsonIds(packRoot: string, directorySegments: string[], target: Set<string>): void {
  const dataRoot = path.join(packRoot, "data");
  const namespaces = workspaceResourceCache.getDirectoryEntriesSync(dataRoot) ?? [];
  for (const namespace of namespaces) {
    if (!namespace.isDirectory()) {
      continue;
    }
    collectJsonIds(path.join(dataRoot, namespace.name, ...directorySegments), namespace.name, "", target);
  }
}

function collectJsonIds(directory: string, namespace: string, prefix: string, target: Set<string>, depth = 0): void {
  if (depth > 16) {
    return;
  }

  const entries = workspaceResourceCache.getDirectoryEntriesSync(directory);
  if (!entries) {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectJsonIds(entryPath, namespace, joinResourcePath(prefix, entry.name), target, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      const idPath = joinResourcePath(prefix, entry.name.slice(0, -".json".length));
      target.add(`${namespace}:${idPath}`);
    }
  }
}

function getAssetsRoots(documentFileName: string, configuration: CitResourceIdConfiguration): string[] {
  const roots: string[] = [];
  const packRoot = workspaceResourceCache.getPackRoot(documentFileName) ?? packRootFromAssetsPath(documentFileName);
  if (packRoot) {
    addAssetsRootCandidates(roots, packRoot);
  }
  for (const root of configuration.resourcePackRoots ?? []) {
    addAssetsRootCandidates(roots, root);
  }
  if (configuration.defaultAssetsPath) {
    addAssetsRootCandidates(roots, configuration.defaultAssetsPath);
  }

  return unique(roots.filter(root => workspaceResourceCache.getDirectoryEntriesSync(root) !== null));
}

function addAssetsRootCandidates(roots: string[], candidate: string): void {
  const normalized = path.normalize(candidate);
  if (path.basename(normalized).toLowerCase() === "assets") {
    roots.push(normalized);
  }
  if (path.basename(path.dirname(normalized)).toLowerCase() === "assets") {
    roots.push(path.dirname(normalized));
  }
  roots.push(path.join(normalized, "assets"));
}

function normalizeResourceId(value: string): string {
  const clean = value.trim();
  return clean.includes(":") ? clean : `minecraft:${clean}`;
}

function joinResourcePath(left: string, right: string): string {
  return left.length > 0 ? `${left}/${right}` : right;
}

function getCacheKey(documentFileName: string, configuration: CitResourceIdConfiguration): string {
  return [
    normalizePathKey(documentFileName),
    configuration.defaultAssetsPath ? normalizePathKey(configuration.defaultAssetsPath) : "",
    (configuration.resourcePackRoots ?? []).map(root => normalizePathKey(root)).join("|")
  ].join("\0");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => path.normalize(value)))];
}
