import * as path from "node:path";
import type { ResourceLocation, ResourceProducer } from "../resourceUniverse";
import type { ResourceGraphProjectedResource, ResourceGraphUriLike } from "./resourceGraphTreeTypes";

export function generatedResourceLabel(resource: ResourceGraphProjectedResource): string {
  return `${resource.target.kind} ${resource.target.id}`;
}

export function generatedResourceDescription(resource: ResourceGraphProjectedResource): string {
  return `${resource.producer.materializationState} · RSGL`;
}

export function generatedResourceContext(resource: ResourceGraphProjectedResource): string {
  const model = resource.target.kind === "model" ? "Model" : "Resource";
  const state = capitalize(resource.producer.materializationState);
  return `resourceGraphGenerated${model}${state}`;
}

export function generatedResourceTooltip(resource: ResourceGraphProjectedResource): string {
  const producer = resource.producer;
  const lines = [
    `${resource.target.kind} ${resource.target.id}`,
    `State: ${producer.materializationState}`,
    `Output: ${producer.outputPath ?? "unavailable"}`,
    `Revision: ${producer.revision}`
  ];
  producer.sourceOrigins.forEach((location, index) => {
    lines.push(`${index === 0 ? "Primary source" : "Contributor"}: ${formatLocation(location)}`);
  });
  producer.physicalOrigins.forEach(location => {
    lines.push(`Materialized: ${formatLocation(location)}`);
  });
  if (resource.candidates && resource.candidates.length > 1) {
    lines.push(`Owners: ${resource.candidates.map(candidate => candidate.producerId).join(", ")}`);
  }
  return lines.join("\n");
}

export function generatedPreviewUri(producer: ResourceProducer): ResourceGraphUriLike | undefined {
  if (producer.materializationState !== "current") {
    return undefined;
  }
  const location = producer.physicalOrigins[0];
  return location ? serializedUriLike(location.uri) : undefined;
}

export function locationLabel(location: ResourceLocation): string {
  const uri = serializedUriLike(location.uri);
  return path.basename(uri.fsPath || location.uri);
}

export function locationDescription(location: ResourceLocation, role: string): string {
  return location.range
    ? `${role} · ${location.range.start}–${location.range.end}`
    : role;
}

export function serializedUriLike(value: string): ResourceGraphUriLike {
  const parsed = new URL(value);
  const fsPath = parsed.protocol === "file:"
    ? decodeURIComponent(parsed.pathname).replace(/^\/(?:([a-zA-Z]):\/)/, "$1:/")
    : decodeURIComponent(parsed.pathname);
  return {
    scheme: parsed.protocol.slice(0, -1),
    fsPath,
    toString: () => value
  };
}

function formatLocation(location: ResourceLocation): string {
  return location.range
    ? `${location.uri} [${location.range.start}–${location.range.end}]`
    : location.uri;
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}
