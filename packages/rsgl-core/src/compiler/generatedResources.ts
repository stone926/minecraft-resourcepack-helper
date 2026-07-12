import { minecraftResourceTarget, tryParseMinecraftResourceId } from "../../../mc-assets/src";
import { isExternalResourceUnit, type ResourceUnit } from "./ir";
import type { RsglResourceExistenceKind } from "./validationTypes";

const generatedReferenceKinds: readonly RsglResourceExistenceKind[] = [
  "model",
  "blockstate",
  "item",
  "texture",
  "textureDirectory",
  "sound",
  "font",
  "fontFile",
  "shaderVertex",
  "shaderFragment"
];

/** Indexes every concrete compiler output that can satisfy a typed reference. */
export function createGeneratedResourceIndex(
  units: readonly ResourceUnit[]
): ReadonlyMap<RsglResourceExistenceKind, ReadonlySet<string>> {
  const result = new Map<RsglResourceExistenceKind, Set<string>>();
  for (const unit of units) {
    if (isExternalResourceUnit(unit)) {
      continue;
    }
    if (unit.id && isGeneratedReferenceKind(unit.kind)) {
      addGeneratedId(result, unit.kind, `${unit.id.namespace}:${unit.id.path}`);
    }
    for (const [kind, id] of generatedIdsFromOutputPath(unit)) {
      addGeneratedId(result, kind, id);
    }
  }
  return result;
}

function generatedIdsFromOutputPath(unit: ResourceUnit): Array<[RsglResourceExistenceKind, string]> {
  let normalized = unit.outputPath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized.startsWith("assets/") && isOverlayUnit(unit)) {
    normalized = normalized.slice(normalized.indexOf("/") + 1);
  }
  const match = /^assets\/([^/]+)\/(.+)$/.exec(normalized);
  if (!match) {
    return [];
  }
  const [, namespace, assetPath] = match;
  const result: Array<[RsglResourceExistenceKind, string]> = [];
  for (const kind of generatedReferenceKinds) {
    if (kind === "textureDirectory") {
      continue;
    }
    const target = minecraftResourceTarget(kind);
    const prefix = `${target.directory}/`;
    if (!assetPath.startsWith(prefix)) {
      continue;
    }
    const targetPath = assetPath.slice(prefix.length);
    const suffix = target.extension === null ? "" : `.${target.extension}`;
    if (suffix && !targetPath.endsWith(suffix)) {
      continue;
    }
    const resourcePath = suffix ? targetPath.slice(0, -suffix.length) : targetPath;
    const id = `${namespace}:${resourcePath}`;
    if (tryParseMinecraftResourceId(id)) {
      result.push([kind, id]);
      if (kind === "texture") {
        const extensionBearingId = `${namespace}:${targetPath}`;
        if (tryParseMinecraftResourceId(extensionBearingId)) {
          result.push([kind, extensionBearingId]);
        }
        result.push(...generatedTextureDirectories(namespace, resourcePath));
      }
    }
  }
  return result;
}

function isOverlayUnit(unit: ResourceUnit): boolean {
  return unit.sourceMap.mappings.some(mapping =>
    mapping.expansionStack.some(frame => frame.label.startsWith("overlay "))
  );
}

function generatedTextureDirectories(
  namespace: string,
  texturePath: string
): Array<[RsglResourceExistenceKind, string]> {
  const segments = texturePath.split("/");
  const result: Array<[RsglResourceExistenceKind, string]> = [];
  for (let length = 1; length < segments.length; length++) {
    result.push(["textureDirectory", `${namespace}:${segments.slice(0, length).join("/")}`]);
  }
  return result;
}

function addGeneratedId(
  index: Map<RsglResourceExistenceKind, Set<string>>,
  kind: RsglResourceExistenceKind,
  id: string
): void {
  const ids = index.get(kind) ?? new Set<string>();
  ids.add(id);
  index.set(kind, ids);
}

function isGeneratedReferenceKind(
  kind: ResourceUnit["kind"]
): kind is "model" | "blockstate" | "item" | "font" {
  return kind === "model" || kind === "blockstate" || kind === "item" || kind === "font";
}
