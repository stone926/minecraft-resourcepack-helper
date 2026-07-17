import { normalizePathKey } from "../../../packages/mc-assets/src";

interface ObservedResourceVersion {
  fileName: string;
  version: string | null;
}

/** Captures first-observed versions and can verify them without retagging old reads. */
export class ResourceVersionSnapshot {
  private readonly observed = new Map<string, ObservedResourceVersion>();

  constructor(private readonly getVersion: (fileName: string) => string | null) {}

  observe(fileName: string): void {
    const key = normalizePathKey(fileName);
    if (!this.observed.has(key)) {
      this.observed.set(key, {
        fileName,
        version: this.getVersion(fileName)
      });
    }
  }

  merge(snapshot: ResourceVersionSnapshot): void {
    for (const [key, observation] of snapshot.observed) {
      if (!this.observed.has(key)) {
        this.observed.set(key, observation);
      }
    }
  }

  consistentVersions(): Map<string, string | null> | null {
    const versions = new Map<string, string | null>();
    for (const observation of this.observed.values()) {
      if (this.getVersion(observation.fileName) !== observation.version) {
        return null;
      }
      versions.set(observation.fileName, observation.version);
    }
    return versions;
  }
}
