import type { WorkspaceResourceCache } from "../services/workspaceResourceCache";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import { arrayElements, memberName, objectMembers, type JsonAstNode } from "../utils/jsonAst";
import type {
  JsonValue,
  RsglResourceContentKind,
  RsglResourceExistenceKind,
  RsglResourceValidationOptions
} from "./compiler";

interface RsglWorkspaceValidationOptions {
  sourceFileName: string;
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
  cache?: WorkspaceResourceCache;
}

type ResourceTarget = {
  target: string;
  extension: string | null;
  directory: boolean;
};

export function createRsglWorkspaceValidationOptions(
  options: RsglWorkspaceValidationOptions
): Pick<RsglResourceValidationOptions, "resourceExists" | "resourceContent" | "textureMetadata"> {
  const cache = options.cache ?? workspaceResourceCache;
  return {
    resourceExists: (kind, id) => resourceExists(cache, options, kind, id),
    resourceContent: (kind, id) => resourceContent(cache, options, kind, id),
    textureMetadata: id => textureMetadata(cache, options, id)
  };
}

function resourceExists(
  cache: WorkspaceResourceCache,
  options: RsglWorkspaceValidationOptions,
  kind: RsglResourceExistenceKind,
  id: string
): boolean {
  const target = resourceTarget(kind);
  const fileName = resolveResource(cache, options, id, target);
  if (!fileName) {
    return false;
  }
  return target.directory
    ? cache.getDirectoryEntriesSync(fileName) !== null
    : cache.getPathExists(fileName);
}

function resourceContent(
  cache: WorkspaceResourceCache,
  options: RsglWorkspaceValidationOptions,
  kind: RsglResourceContentKind,
  id: string
): JsonValue | null {
  const target = resourceTarget(kind);
  const fileName = resolveResource(cache, options, id, target);
  if (!fileName) {
    return null;
  }
  const ast = cache.getJsonFileAst(fileName);
  return ast ? astNodeToJsonValue(ast.body) ?? null : null;
}

function textureMetadata(
  cache: WorkspaceResourceCache,
  options: RsglWorkspaceValidationOptions,
  id: string
): { width: number; height: number } | null {
  const fileName = resolveResource(cache, options, id, resourceTarget("texture"));
  return fileName ? cache.getPngMetadata(fileName) : null;
}

function resolveResource(
  cache: WorkspaceResourceCache,
  options: RsglWorkspaceValidationOptions,
  id: string,
  target: ResourceTarget
): string | null {
  return cache.resolveResourcePath({
    resourcePath: id,
    sourceFileName: options.sourceFileName,
    source: "rsgl",
    target: target.target,
    targetFileExtension: target.extension,
    defaultAssetsPath: options.defaultAssetsPath,
    resourcePackRoots: options.resourcePackRoots
  });
}

function resourceTarget(kind: RsglResourceExistenceKind | RsglResourceContentKind): ResourceTarget {
  if (kind === "model") {
    return { target: "models", extension: "json", directory: false };
  }
  if (kind === "textureDirectory") {
    return { target: "textures", extension: null, directory: true };
  }
  if (kind === "texture") {
    return { target: "textures", extension: "png", directory: false };
  }
  if (kind === "font") {
    return { target: "font", extension: "json", directory: false };
  }
  if (kind === "fontFile") {
    return { target: "font", extension: null, directory: false };
  }
  if (kind === "shaderVertex") {
    return { target: "shaders", extension: "vsh", directory: false };
  }
  if (kind === "shaderFragment") {
    return { target: "shaders", extension: "fsh", directory: false };
  }
  return { target: "sounds", extension: "ogg", directory: false };
}

function astNodeToJsonValue(node: JsonAstNode | null | undefined): JsonValue | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "Element") {
    return astNodeToJsonValue(node.value);
  }
  if (node.type === "Object") {
    const result: Record<string, JsonValue> = {};
    for (const member of objectMembers(node)) {
      const name = memberName(member);
      const value = astNodeToJsonValue(member.value);
      if (name !== undefined && value !== undefined) {
        result[name] = value;
      }
    }
    return result;
  }
  if (node.type === "Array") {
    const result: JsonValue[] = [];
    for (const element of arrayElements(node)) {
      const value = astNodeToJsonValue(element);
      if (value !== undefined) {
        result.push(value);
      }
    }
    return result;
  }
  if (node.type === "String") {
    return node.value;
  }
  if (node.type === "Number") {
    return node.value;
  }
  if (node.type === "Boolean") {
    return node.value;
  }
  if (node.type === "Null") {
    return null;
  }
  return undefined;
}
