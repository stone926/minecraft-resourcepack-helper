import { ResourceId } from "./ir";
import {
  minecraftResourceIdToString,
  minecraftResourceOutputPath,
  tryParseMinecraftResourceId
} from "../../../rsgl-shared/src";

export function parseResourceId(value: string, defaultNamespace = "minecraft"): ResourceId | null {
  return tryParseMinecraftResourceId(value, defaultNamespace);
}

export function resourceIdToString(id: ResourceId): string {
  return minecraftResourceIdToString(id);
}

export function resourceOutputPath(kind: string, id: ResourceId, extension = "json"): string {
  return minecraftResourceOutputPath(kind, id, extension);
}
