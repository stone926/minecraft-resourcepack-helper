import { ResourceId } from "./ir";

const namespacePattern = /^[a-z0-9_.-]+$/;
const resourcePathPattern = /^[a-z0-9_./-]+$/;

export function parseResourceId(value: string, defaultNamespace = "minecraft"): ResourceId | null {
  const [namespace, ...pathParts] = value.includes(":")
    ? value.split(":")
    : [defaultNamespace, value];
  const resourcePath = pathParts.join(":");
  if (!namespacePattern.test(namespace) || !resourcePathPattern.test(resourcePath) || resourcePath.length === 0) {
    return null;
  }
  return { namespace, path: resourcePath };
}

export function resourceIdToString(id: ResourceId): string {
  return `${id.namespace}:${id.path}`;
}

export function resourceOutputPath(kind: string, id: ResourceId, extension = "json"): string {
  if (kind === "model") {
    return `assets/${id.namespace}/models/${id.path}.${extension}`;
  }
  if (kind === "blockstate") {
    return `assets/${id.namespace}/blockstates/${id.path}.${extension}`;
  }
  if (kind === "item") {
    return `assets/${id.namespace}/items/${id.path}.${extension}`;
  }
  if (kind === "atlas") {
    return `assets/${id.namespace}/atlases/${id.path}.${extension}`;
  }
  if (kind === "particles") {
    return `assets/${id.namespace}/particles/${id.path}.${extension}`;
  }
  if (kind === "equipment") {
    return `assets/${id.namespace}/equipment/${id.path}.${extension}`;
  }
  return `assets/${id.namespace}/${kind}/${id.path}.${extension}`;
}
