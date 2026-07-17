import { packRootFromAssetsPath } from "../../../packages/mc-assets/src";
import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import type { ResourceReference } from "../../utils/resourceReferences";
import { citResourceTypeFor } from "../citAssetResolver";
import type { CitResourceType } from "../citKeyResolution";
import { getCitPathCandidates } from "../citPaths";

export interface CitPackRootResolver {
  getPackRoot(fileName: string): string | null;
}

export interface MissingCitResourcePlan {
  targetPath: string;
  content: Uint8Array;
}

const missingPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lLD9WQAAAABJRU5ErkJggg==",
  "base64"
);

/** Plans target selection and initial content without depending on VS Code APIs. */
export class MissingCitResourcePlanner {
  public constructor(
    private readonly packRoots: CitPackRootResolver = workspaceResourceCache
  ) {}

  public targetPath(documentFileName: string, reference: ResourceReference): string | null {
    const resourceType = resourceTypeFor(reference);
    if (!resourceType) {
      return null;
    }

    const packRoot = this.packRoots.getPackRoot(documentFileName)
      ?? packRootFromAssetsPath(documentFileName);
    if (!packRoot) {
      return null;
    }

    return getCitPathCandidates(
      documentFileName,
      packRoot,
      reference.value,
      resourceType
    )[0] ?? null;
  }

  public plan(documentFileName: string, reference: ResourceReference): MissingCitResourcePlan | null {
    const targetPath = this.targetPath(documentFileName, reference);
    if (!targetPath) {
      return null;
    }
    return {
      targetPath,
      content: defaultContentFor(reference)
    };
  }
}

function resourceTypeFor(reference: ResourceReference): CitResourceType | null {
  if (reference.origin === "citAutoDiscovery") {
    return "models";
  }
  return citResourceTypeFor(reference.target, reference.extension);
}

function defaultContentFor(reference: ResourceReference): Uint8Array {
  if (resourceTypeFor(reference) === "textures") {
    return missingPng;
  }

  return Buffer.from(`${JSON.stringify({
    parent: "minecraft:item/generated",
    textures: {
      layer0: "minecraft:item/generated"
    }
  }, null, 2)}\n`, "utf8");
}
