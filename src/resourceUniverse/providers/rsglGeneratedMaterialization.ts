import { uniqueValues } from "../../../packages/mc-assets/src";
import type { ResourceMaterializationState, ResourceLocation } from "../core";

export type RsglGeneratedMaterializationState = Extract<
  ResourceMaterializationState,
  "current" | "stale" | "conflict"
>;

export interface RsglGeneratedMaterializedLocation {
  uri: string;
  editable?: boolean;
}

/**
 * One ownership-aware materialization fact. `owned` must come from a validated
 * ownership manifest; path equality alone is deliberately insufficient.
 */
export interface RsglGeneratedMaterializationEntry {
  producerId: string;
  outputPath: string;
  state: RsglGeneratedMaterializationState;
  owned: boolean;
  /** Producer revision that was materialized, when recorded by the writer. */
  producerRevision?: string;
  locations: readonly RsglGeneratedMaterializedLocation[];
}

export interface RsglGeneratedMaterializationSnapshot {
  projectId: string;
  revision: string;
  entries: readonly RsglGeneratedMaterializationEntry[];
  /** Includes valid manifests owned by sibling RSGL projects sharing this output pack. */
  ownedOutputPaths?: readonly string[];
  status?: "authoritative" | "missing" | "partial";
  issues?: readonly string[];
}

export interface RsglGeneratedMaterializationProjection {
  state: RsglGeneratedMaterializationState;
  locations: readonly ResourceLocation[];
  owned: boolean;
}

interface StoredMaterializations {
  revision: string;
  signature: string;
  entriesByProducerId: ReadonlyMap<string, RsglGeneratedMaterializationEntry>;
  ownedOutputPaths: ReadonlySet<string>;
  status: "authoritative" | "missing" | "partial";
  issues: readonly string[];
}

/** Project-scoped ownership facts kept separate from semantic snapshot state. */
export class RsglGeneratedMaterializationIndex {
  private readonly projects = new Map<string, StoredMaterializations>();

  public replace(snapshot: RsglGeneratedMaterializationSnapshot): boolean {
    const projectId = requireIdentity(snapshot.projectId, "projectId");
    const revision = requireIdentity(snapshot.revision, "revision");
    const entries = snapshot.entries.map(normalizeEntry).sort(compareEntries);
    const ownedOutputPaths = new Set([
      ...entries.filter(entry => entry.owned).map(entry => entry.outputPath),
      ...(snapshot.ownedOutputPaths ?? []).map(outputPath =>
        normalizePortableOutputPath(outputPath))
    ]);
    const status = snapshot.status ?? "authoritative";
    const issues = uniqueValues(snapshot.issues ?? []).sort((left, right) =>
      left.localeCompare(right, "en"));
    const entriesByProducerId = new Map<string, RsglGeneratedMaterializationEntry>();
    for (const entry of entries) {
      if (entriesByProducerId.has(entry.producerId)) {
        throw new Error(`Duplicate RSGL materialization producer '${entry.producerId}'.`);
      }
      entriesByProducerId.set(entry.producerId, entry);
    }

    const signature = JSON.stringify({
      entries,
      ownedOutputPaths: [...ownedOutputPaths].sort((left, right) => left.localeCompare(right, "en")),
      status,
      issues
    });
    const current = this.projects.get(projectId);
    if (current?.revision === revision) {
      if (current.signature !== signature) {
        throw new Error(`RSGL materialization revision '${revision}' has inconsistent facts.`);
      }
      return false;
    }
    this.projects.set(projectId, {
      revision,
      signature,
      entriesByProducerId,
      ownedOutputPaths,
      status,
      issues
    });
    return true;
  }

  public project(
    projectId: string,
    producerId: string,
    outputPath: string,
    producerRevision: string
  ): RsglGeneratedMaterializationProjection | undefined {
    const entry = this.projects.get(projectId)?.entriesByProducerId.get(producerId);
    if (!entry || entry.outputPath !== outputPath) {
      return undefined;
    }
    const state = entry.state === "current"
      && entry.producerRevision !== undefined
      && entry.producerRevision !== producerRevision
      ? "stale"
      : entry.state;
    return {
      state,
      owned: entry.owned,
      locations: entry.owned
        ? entry.locations.map(location => ({
            uri: location.uri,
            origin: "materialized" as const,
            editable: location.editable ?? isEditableUri(location.uri)
          }))
        : []
    };
  }

  /** Paths to exclude from the handwritten physical provider. */
  public getOwnedOutputPaths(projectId: string): ReadonlySet<string> {
    return new Set(this.projects.get(projectId)?.ownedOutputPaths ?? []);
  }

  public getRevision(projectId: string): string | undefined {
    return this.projects.get(projectId)?.revision;
  }

  public getStatus(projectId: string): {
    status: "authoritative" | "missing" | "partial";
    issues: readonly string[];
  } | undefined {
    const stored = this.projects.get(projectId);
    return stored ? { status: stored.status, issues: [...stored.issues] } : undefined;
  }

  public removeProject(projectId: string): void {
    this.projects.delete(projectId);
  }

  public clear(): void {
    this.projects.clear();
  }
}

function normalizeEntry(entry: RsglGeneratedMaterializationEntry): RsglGeneratedMaterializationEntry {
  const producerId = requireIdentity(entry.producerId, "producerId");
  const outputPath = normalizePortableOutputPath(entry.outputPath);
  if (entry.state !== "current" && entry.state !== "stale" && entry.state !== "conflict") {
    throw new Error(`Invalid RSGL materialization state '${String(entry.state)}'.`);
  }
  if (!entry.owned && entry.state !== "conflict") {
    throw new Error("An unowned RSGL output can only be represented as a conflict.");
  }
  return {
    producerId,
    outputPath,
    state: entry.state,
    owned: entry.owned,
    ...(entry.producerRevision === undefined
      ? {}
      : { producerRevision: requireIdentity(entry.producerRevision, "producerRevision") }),
    locations: uniqueLocations(entry.locations.map(location => ({
      uri: requireSerializedUri(location.uri),
      ...(location.editable === undefined ? {} : { editable: location.editable })
    })))
  };
}

function uniqueLocations(
  locations: readonly RsglGeneratedMaterializedLocation[]
): RsglGeneratedMaterializedLocation[] {
  return [...new Map(locations.map(location => [location.uri, location])).values()]
    .sort((left, right) => left.uri.localeCompare(right.uri, "en"));
}

function compareEntries(
  left: RsglGeneratedMaterializationEntry,
  right: RsglGeneratedMaterializationEntry
): number {
  return left.producerId.localeCompare(right.producerId, "en")
    || left.outputPath.localeCompare(right.outputPath, "en");
}

function normalizePortableOutputPath(value: string): string {
  const raw = requireIdentity(value, "outputPath").replaceAll("\\", "/");
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new Error("RSGL materialization outputPath must be a portable relative path.");
  }
  const segments = raw.split("/").filter(segment => segment !== ".");
  if (segments.length === 0 || segments.some(segment => !segment || segment === "..")) {
    throw new Error("RSGL materialization outputPath must be a portable relative path.");
  }
  return segments.join("/");
}

function requireSerializedUri(value: string): string {
  const uri = requireIdentity(value, "materialized location URI");
  if (/^[a-zA-Z]:[\\/]/.test(uri) || !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(uri)) {
    throw new Error(`RSGL materialized location '${uri}' is not a serialized URI.`);
  }
  return uri;
}

function requireIdentity(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty identity.`);
  }
  return value.trim();
}

function isEditableUri(uri: string): boolean {
  return uri.startsWith("file:") || uri.startsWith("vscode-remote:");
}
