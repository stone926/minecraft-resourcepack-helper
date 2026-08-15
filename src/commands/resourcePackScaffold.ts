import * as fs from "node:fs";
import * as path from "node:path";
import { getResourceIncomingReferenceRoots } from "../resources/resourceSurfaceRegistry";
import { defaultPackPng, getPackMcmeta } from "./constants";

/** Directories created only by scaffolding, on top of the registry's reference roots. */
const scaffoldOnlyDirectories = [
  "textures/block",
  "textures/font",
  "textures/gui",
  "textures/item",
  "shaders/post"
];

function referenceRootsUnder(prefix: string): string[] {
  return getResourceIncomingReferenceRoots()
    .map(root => root.root)
    .filter(root => root === prefix || root.startsWith(`${prefix}/`));
}

function withAncestors(directories: readonly string[]): string[] {
  const all = new Set<string>();
  for (const directory of directories) {
    const segments = directory.split("/");
    for (let index = 1; index <= segments.length; index++) {
      all.add(segments.slice(0, index).join("/"));
    }
  }
  return [...all].sort();
}

export const resourcePackNamespaceDirectories: readonly string[] = [
  "atlases",
  "blockstates",
  "equipment",
  "font",
  "items",
  "lang",
  "models",
  path.join("models", "block"),
  path.join("models", "item"),
  "particles",
  "post_effect",
  "sounds",
  "texts",
  "waypoint_style",
  ...withAncestors([
    ...referenceRootsUnder("textures"),
    ...referenceRootsUnder("shaders"),
    ...scaffoldOnlyDirectories
  ]).map(directory => path.join(...directory.split("/")))
];

const windowsReservedFileName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** A pack name is one portable directory segment, never a path supplied by the user. */
export function isValidPackDirectoryName(value: string): boolean {
  const name = value.trim();
  return name.length > 0
    && name !== "."
    && name !== ".."
    && !path.isAbsolute(name)
    && !/[<>:"/\\|?*]/.test(name)
    && ![...name].some(character => character.charCodeAt(0) < 32)
    && !/[. ]$/.test(name)
    && !windowsReservedFileName.test(name);
}

/** Minecraft namespaces are also filesystem directory names, so dot segments are excluded. */
export function isValidResourcePackNamespace(value: string): boolean {
  const namespace = value.trim();
  return /^[a-z0-9_.-]+$/.test(namespace)
    && isValidPackDirectoryName(namespace);
}

export function writePackScaffold(packPath: string, namespace: string, packFormat: string, description: string) {
  fs.mkdirSync(packPath);
  writePackRootFiles(packPath, packFormat, description);
  createNamespaceFolders(packPath, namespace);
}

export function writePackRootFiles(packPath: string, packFormat: string, description: string) {
  const packMcmeta = getPackMcmeta(packFormat, description);
  fs.writeFileSync(path.join(packPath, "pack.mcmeta"), packMcmeta, { flag: "wx" });
  fs.writeFileSync(path.join(packPath, "pack.png"), Buffer.from(defaultPackPng, "base64"), { flag: "wx" });
}

export function createNamespaceFolders(packPath: string, namespace: string) {
  const normalizedNamespace = namespace.trim();
  if (!isValidResourcePackNamespace(normalizedNamespace)) {
    throw new RangeError(`Invalid resource pack namespace: ${namespace}`);
  }
  const namespacePath = path.join(packPath, "assets", normalizedNamespace);
  for (const resourcePath of resourcePackNamespaceDirectories) {
    fs.mkdirSync(path.join(namespacePath, resourcePath), { recursive: true });
  }
}
