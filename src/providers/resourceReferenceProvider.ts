import * as vscode from "vscode";
import type { ResourceUniverseNavigation } from "../services/resourceUniverseNavigationFacade";

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

      const locations = await Promise.all(result.references.map(async reference => {
        if (token.isCancellationRequested) {
          return undefined;
        }
        const uri = reference.sourceUri;
        try {
          const source = await vscode.workspace.openTextDocument(uri);
          const range = reference.sourceRange
            ? new vscode.Range(
                source.positionAt(reference.sourceRange.start),
                source.positionAt(reference.sourceRange.end)
              )
            : new vscode.Range(0, 0, 0, 0);
          return new vscode.Location(uri, range);
        } catch {
          return new vscode.Location(uri, new vscode.Position(0, 0));
        }
      }));
      if (context.includeDeclaration) {
        locations.unshift(new vscode.Location(document.uri, new vscode.Position(0, 0)));
      }
      return uniqueLocations(locations.filter((location): location is vscode.Location => !!location));
    }
  };
}

function uniqueLocations(locations: readonly vscode.Location[]): vscode.Location[] {
  return [...new Map(locations.map(location => [
    `${location.uri.toString()}\0${location.range.start.line}\0${location.range.start.character}`
      + `\0${location.range.end.line}\0${location.range.end.character}`,
    location
  ])).values()];
}
