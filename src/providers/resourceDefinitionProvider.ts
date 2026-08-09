import * as vscode from "vscode";
import type { ResourceLocation, ResourceNavigationResult } from "../resourceUniverse";
import type { ResourceUniverseNavigation } from "../services/resourceUniverseNavigation";
import {
  cancellationTokenToAbortSignal,
  toVscodeLocation,
  uniqueOffsetLocations
} from "../utils/resourceLocationVscode";
import { findResourceReferenceAtPosition } from "../utils/resourceReferences";

export function createResourceDefinitionProvider(
  navigation: ResourceUniverseNavigation
): vscode.DefinitionProvider {
  return {
    provideDefinition: async (document, position, token) => {
      const reference = findResourceReferenceAtPosition(document, position);
      if (!reference || reference.value.startsWith("#") || token.isCancellationRequested) {
        return null;
      }

      const cancellation = cancellationTokenToAbortSignal(token);
      const resolution = await navigation.resolveReference(document, reference, {
        includeGenerated: true,
        signal: cancellation.signal
      }).finally(cancellation.dispose);
      if (token.isCancellationRequested) {
        return null;
      }
      const locations = await toDefinitionLocations(
        resolution.navigation,
        resolution.targetUri,
        token
      );
      return locations.length === 0 ? null : locations.length === 1 ? locations[0] : locations;
    }
  };
}

async function toDefinitionLocations(
  navigation: ResourceNavigationResult | undefined,
  fallbackUri: vscode.Uri | null,
  token: vscode.CancellationToken
): Promise<vscode.Location[]> {
  const locations = navigationLocations(navigation);
  if (locations.length === 0 && fallbackUri) {
    locations.push({ uri: fallbackUri.toString(), origin: "physical" });
  }
  const resolved = await Promise.all(uniqueOffsetLocations(locations).map(location =>
    toVscodeLocation(location, token)
  ));
  return resolved.filter((location): location is vscode.Location => location !== undefined);
}

function navigationLocations(navigation: ResourceNavigationResult | undefined): ResourceLocation[] {
  if (!navigation) {
    return [];
  }
  if (navigation.status === "resolved") {
    return [navigation.primary, ...navigation.alternatives];
  }
  return navigation.candidates.flatMap(producer => [
    ...producer.sourceOrigins,
    ...producer.physicalOrigins
  ]);
}
