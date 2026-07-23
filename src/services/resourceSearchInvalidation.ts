import { canonicalizeResourceGraphOutputPath } from "../../packages/mc-assets/src";
import type { ResourceUniverseChangeEvent } from "../resourceUniverse";
import type { ResourceGraphPathChangeKind } from "../utils/resourceGraph";
import { isResourceSearchKind } from "./resourceSearchModel";

/**
 * Search inventory membership is path-based for physical resources. Content
 * edits can change graph edges, but only structural changes to searchable
 * output paths can add or remove blockstate/model/texture search entries.
 */
export function isResourceSearchInventoryPath(fileName: string): boolean {
  const identity = canonicalizeResourceGraphOutputPath(fileName, {
    fileSystemCaseSensitive: false
  });
  return identity !== null && isResourceSearchKind(identity.primaryKey.kind);
}

export function resourcePathChangeAffectsSearchInventory(
  fileName: string,
  kind: ResourceGraphPathChangeKind
): boolean {
  return kind !== "change" && isResourceSearchInventoryPath(fileName);
}

/**
 * Workspace physical changes are classified at the path boundary above.
 * Provider-level generated facts do not have a physical path and therefore
 * invalidate the inventory through their provider event.
 */
export function resourceUniverseChangeAffectsSearchInventory(
  event: ResourceUniverseChangeEvent
): boolean {
  return event.kind === "removal"
    || event.providerIds.some(providerId => providerId !== "physical");
}
