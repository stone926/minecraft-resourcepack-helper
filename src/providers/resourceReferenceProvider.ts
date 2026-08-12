import * as vscode from "vscode";
import type { ResourceUniverseNavigation } from "../services/resourceUniverseNavigation";
import { toVscodeLocations, uniqueVscodeLocations } from "../utils/resourceLocationVscode";

/**
 * Main-side References bridge for physical definition files. RSGL documents
 * remain owned by the language server, while incoming Universe edges merge
 * physical and generated consumers here.
 */
export function createResourceReferenceProvider(
  navigation: ResourceUniverseNavigation
): vscode.ReferenceProvider {
  return {
    provideReferences: async (document, _position, context, token) => {
      const result = await navigation.getIncomingReferences(
        document.uri,
        undefined,
        { includeGenerated: true }
      );
      if (token.isCancellationRequested || result.coverage === "unavailable") {
        return undefined;
      }

      const locations = await toVscodeLocations(result.references.map(reference => ({
        uri: reference.sourceUri,
        range: reference.sourceRange
      })), token);
      if (context.includeDeclaration) {
        locations.unshift(new vscode.Location(document.uri, new vscode.Position(0, 0)));
      }
      return uniqueVscodeLocations(locations.filter((location): location is vscode.Location => !!location));
    }
  };
}
