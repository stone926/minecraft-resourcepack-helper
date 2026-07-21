import * as vscode from "vscode";
import type { ResourceLocation, ResourceNavigationResult } from "../resourceUniverse";
import type { ResourceUniverseNavigation } from "../services/resourceUniverseNavigationFacade";
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

      const cancellation = cancellationSignal(token);
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
  const resolved = await Promise.all(uniqueResourceLocations(locations).map(location =>
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

async function toVscodeLocation(
  location: ResourceLocation,
  token: vscode.CancellationToken
): Promise<vscode.Location | undefined> {
  const uri = vscode.Uri.parse(location.uri, true);
  if (!location.range) {
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    if (token.isCancellationRequested) {
      return undefined;
    }
    return new vscode.Location(uri, new vscode.Range(
      document.positionAt(location.range.start),
      document.positionAt(location.range.end)
    ));
  } catch {
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }
}

function uniqueResourceLocations(locations: readonly ResourceLocation[]): ResourceLocation[] {
  return [...new Map(locations.map(location => [
    `${location.uri}\0${location.range?.start ?? 0}\0${location.range?.end ?? 0}`,
    location
  ])).values()];
}

function cancellationSignal(token: vscode.CancellationToken): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
    return { signal: controller.signal, dispose: () => undefined };
  }
  const subscription = token.onCancellationRequested(() => {
    controller.abort();
  });
  return { signal: controller.signal, dispose: () => subscription.dispose() };
}
