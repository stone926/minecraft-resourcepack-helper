import * as path from "node:path";
import { parseAssetsPath } from "../../packages/mc-assets/src";
import { isResourceSurfaceFile } from "../resources/resourceSurfaceRegistry";

export interface AssetResource {
  namespace: string;
  resourcePath: string;
}

export interface IncomingReferenceSearch {
  readonly values: Set<string>;
  matchesText(text: string): boolean;
}

interface AssetUriLike {
  readonly scheme: string;
  readonly fsPath: string;
}

export function createIncomingReferenceSearch(targetUri: AssetUriLike): IncomingReferenceSearch | null {
  const targetResource = targetUri.scheme === "file" ? getAssetResource(targetUri.fsPath) : null;
  if (!targetResource) {
    return null;
  }

  const values = new Set<string>();
  for (const rawPath of getPossibleReferencePaths(targetResource.resourcePath)) {
    addSearchValues(values, targetResource.namespace, rawPath);
  }

  return {
    values,
    matchesText: (text: string) => {
      if (text.includes("\\u")) {
        return true;
      }

      for (const value of values) {
        if (text.includes(value)) {
          return true;
        }
      }

      return false;
    }
  };
}

export function getAssetResource(fsPath: string): AssetResource | null {
  const parsed = parseAssetsPath(fsPath);
  if (!parsed || parsed.relativeSegments.length === 0) {
    return null;
  }

  return {
    namespace: parsed.namespace,
    resourcePath: parsed.relativeSegments.join("/")
  };
}

export function resourceUriKey(uri: AssetUriLike): string {
  const key = uri.scheme === "file" ? path.normalize(uri.fsPath) : uri.toString();
  return process.platform === "win32" ? key.toLowerCase() : key;
}

export function isModelDocumentPath(fileName: string): boolean {
  return /[\\/]models[\\/].+\.json$/i.test(fileName);
}

export function isResourceJsonDocumentPath(fileName: string): boolean {
  return /[\\/]assets[\\/][^\\/]+[\\/].+\.json$/i.test(fileName);
}

export function isResourceGraphDocumentPath(fileName: string): boolean {
  return isResourceSurfaceFile(fileName, "graph");
}

function getPossibleReferencePaths(resourcePath: string): Set<string> {
  const paths = new Set<string>();
  const normalizedResourcePath = resourcePath.replaceAll("\\", "/");
  const pathWithoutExtension = stripExtension(normalizedResourcePath);
  const basenameWithoutExtension = path.posix.basename(pathWithoutExtension);
  const basename = path.posix.basename(normalizedResourcePath);
  const targetRoots = [
    "",
    "models",
    "textures",
    "textures/particle",
    "textures/entity",
    "textures/entity/bed",
    "textures/entity/chest",
    "textures/entity/shulker",
    "textures/entity/signs",
    "textures/entity/signs/hanging",
    "textures/effect",
    "textures/gui/sprites/hud/locator_bar_dot",
    "font",
    "shaders",
    "shaders/core",
    "shaders/include",
    "sounds"
  ];

  for (const targetRoot of targetRoots) {
    addReferencePathForTargetRoot(paths, normalizedResourcePath, pathWithoutExtension, targetRoot);
  }

  if (basenameWithoutExtension.length > 0) {
    paths.add(basenameWithoutExtension);
  }
  if (basename.length > 0) {
    paths.add(basename);
  }

  addEquipmentReferencePath(paths, normalizedResourcePath, pathWithoutExtension);
  return paths;
}

function addReferencePathForTargetRoot(
  paths: Set<string>,
  resourcePath: string,
  pathWithoutExtension: string,
  targetRoot: string
): void {
  const normalizedRoot = targetRoot.length > 0 ? `${targetRoot}/` : "";
  if (targetRoot.length > 0 && !resourcePath.startsWith(normalizedRoot)) {
    return;
  }

  const rawPath = targetRoot.length > 0 ? resourcePath.slice(normalizedRoot.length) : resourcePath;
  const rawPathWithoutExtension = targetRoot.length > 0
    ? pathWithoutExtension.slice(normalizedRoot.length)
    : pathWithoutExtension;

  if (rawPathWithoutExtension.length > 0) {
    paths.add(rawPathWithoutExtension);
  }

  if (rawPath.length > 0) {
    paths.add(rawPath);
  }
}

function addEquipmentReferencePath(paths: Set<string>, resourcePath: string, pathWithoutExtension: string): void {
  const equipmentRoot = "textures/entity/equipment/";
  if (!resourcePath.startsWith(equipmentRoot)) {
    return;
  }

  const rawPath = resourcePath.slice(equipmentRoot.length);
  const rawPathWithoutExtension = pathWithoutExtension.slice(equipmentRoot.length);
  const slashIndex = rawPath.indexOf("/");

  if (slashIndex < 0) {
    return;
  }

  const texturePath = rawPath.slice(slashIndex + 1);
  const texturePathWithoutExtension = rawPathWithoutExtension.slice(slashIndex + 1);

  if (texturePathWithoutExtension.length > 0) {
    paths.add(texturePathWithoutExtension);
  }

  if (texturePath.length > 0) {
    paths.add(texturePath);
  }
}

function addSearchValues(values: Set<string>, namespace: string, rawPath: string): void {
  const normalizedPath = rawPath.replaceAll("\\", "/");
  addJsonStringValues(values, `${namespace}:${normalizedPath}`);
  addJsonStringValues(values, `${namespace.toLowerCase()}:${normalizedPath.toLowerCase()}`);
  values.add(`${namespace}:${normalizedPath}`);
  values.add(`${namespace.toLowerCase()}:${normalizedPath.toLowerCase()}`);
  values.add(`assets/${namespace}/${normalizedPath}`);
  values.add(`assets/${namespace.toLowerCase()}/${normalizedPath.toLowerCase()}`);
  values.add(normalizedPath);
  values.add(normalizedPath.toLowerCase());

  if (namespace === "minecraft") {
    addJsonStringValues(values, normalizedPath);
    addJsonStringValues(values, normalizedPath.toLowerCase());
  }
}

function addJsonStringValues(values: Set<string>, value: string): void {
  values.add(JSON.stringify(value));

  if (value.includes("/")) {
    values.add(JSON.stringify(value.replaceAll("/", "\\")));
    values.add(JSON.stringify(value).replaceAll("/", "\\/"));
  }
}

function stripExtension(value: string): string {
  const extension = path.posix.extname(value);
  return extension ? value.slice(0, -extension.length) : value;
}
