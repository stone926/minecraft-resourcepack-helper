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
  const namespacePath = path.join(packPath, "assets", namespace);
  for (const resourcePath of resourcePackNamespaceDirectories) {
    fs.mkdirSync(path.join(namespacePath, resourcePath), { recursive: true });
  }
}
