import { ResourceId } from "./ir";
import {
  minecraftResourceIdToString,
  minecraftResourceOutputPath,
  minecraftResourceTarget,
  tryParseMinecraftResourceId
} from "../../../mc-assets/src";

export function parseResourceId(value: string, defaultNamespace = "minecraft"): ResourceId | null {
  return tryParseMinecraftResourceId(value, defaultNamespace);
}

export function resourceIdToString(id: ResourceId): string {
  return minecraftResourceIdToString(id);
}

export function resourceOutputPath(
  kind: string,
  id: ResourceId,
  extension = "json"
): string {
  return minecraftResourceOutputPath(kind, id, extension);
}

export function resourceTargetOutputPath(kind: string, id: ResourceId): string {
  const target = minecraftResourceTarget(kind);
  const basePath = `assets/${id.namespace}/${target.directory}/${id.path}`;
  const suffix = target.extension ? `.${target.extension}` : "";
  return suffix && !basePath.endsWith(suffix) ? `${basePath}${suffix}` : basePath;
}
