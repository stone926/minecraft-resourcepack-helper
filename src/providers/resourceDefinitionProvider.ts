import * as vscode from "vscode";
import type { ResourceNavigationResult } from "../resourceUniverse";
import type { ResourceUniverseNavigation } from "../services/resourceUniverseNavigation";
import {
  cancellationTokenToAbortSignal,
  toVscodeLocation
} from "../utils/resourceLocationVscode";
import { findResourceReferenceAtPosition } from "../utils/resourceReferences";
import { definitionLocationsForNavigation } from "./resourceDefinitionMapping";

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
  const locations = definitionLocationsForNavigation(navigation, fallbackUri?.toString() ?? null);
  const resolved = await Promise.all(locations.map(location =>
    toVscodeLocation(location, token)
  ));
  return resolved.filter((location): location is vscode.Location => location !== undefined);
}
