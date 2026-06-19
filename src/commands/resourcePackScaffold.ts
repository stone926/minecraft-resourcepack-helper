import * as fs from "node:fs";
import * as path from "node:path";
import { defaultPackPng, getPackMcmeta } from "./constants";

export const resourcePackNamespaceDirectories = [
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
  "shaders",
  path.join("shaders", "core"),
  path.join("shaders", "include"),
  path.join("shaders", "post"),
  "sounds",
  "texts",
  "textures",
  path.join("textures", "block"),
  path.join("textures", "entity"),
  path.join("textures", "entity", "bed"),
  path.join("textures", "entity", "chest"),
  path.join("textures", "entity", "equipment"),
  path.join("textures", "entity", "shulker"),
  path.join("textures", "entity", "signs"),
  path.join("textures", "entity", "signs", "hanging"),
  path.join("textures", "effect"),
  path.join("textures", "font"),
  path.join("textures", "gui"),
  path.join("textures", "gui", "sprites"),
  path.join("textures", "gui", "sprites", "hud"),
  path.join("textures", "gui", "sprites", "hud", "locator_bar_dot"),
  path.join("textures", "item"),
  path.join("textures", "particle"),
  "waypoint_style"
] as const;

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
