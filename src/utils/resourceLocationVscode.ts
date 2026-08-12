import * as vscode from "vscode";

export interface OffsetRangeLocationLike {
  uri: vscode.Uri | string;
  range?: { start: number; end: number };
}

export interface LineCharacterRangeLike {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

type LocationDocumentLoader = (uri: vscode.Uri) => Promise<vscode.TextDocument | null>;

/** Maps a VS Code-free line/character range onto the editor API. */
export function toVscodeRange(range: LineCharacterRangeLike): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character)
  );
}

/**
 * Maps a byte-offset location onto a `vscode.Location` by opening the target
 * document. Locations without a range, and unreadable targets, resolve to the
 * document start; a cancelled token resolves to undefined.
 */
export async function toVscodeLocation(
  location: OffsetRangeLocationLike,
  token?: vscode.CancellationToken
): Promise<vscode.Location | undefined> {
  return (await toVscodeLocations([location], token))[0];
}

/**
 * Maps locations in input order while opening each distinct ranged URI at most
 * once for this batch. Unranged and unreadable targets retain the same
 * document-start fallback used by the single-location bridge.
 */
export async function toVscodeLocations(
  locations: readonly OffsetRangeLocationLike[],
  token?: vscode.CancellationToken
): Promise<Array<vscode.Location | undefined>> {
  const loadDocument = createLocationDocumentLoader();
  return Promise.all(locations.map(location =>
    toVscodeLocationWithLoader(location, loadDocument, token)
  ));
}

async function toVscodeLocationWithLoader(
  location: OffsetRangeLocationLike,
  loadDocument: LocationDocumentLoader,
  token?: vscode.CancellationToken
): Promise<vscode.Location | undefined> {
  const uri = typeof location.uri === "string" ? vscode.Uri.parse(location.uri, true) : location.uri;
  if (!location.range) {
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }
  const document = await loadDocument(uri);
  if (!document) {
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }
  if (token?.isCancellationRequested) {
    return undefined;
  }
  return new vscode.Location(uri, new vscode.Range(
    document.positionAt(location.range.start),
    document.positionAt(location.range.end)
  ));
}

/** Creates a request-bounded, failure-containing document loader. */
export function createLocationDocumentLoader(): LocationDocumentLoader {
  const documents = new Map<string, Promise<vscode.TextDocument | null>>();
  return uri => {
    const key = uri.toString();
    const cached = documents.get(key);
    if (cached) {
      return cached;
    }
    let document: Promise<vscode.TextDocument | null>;
    try {
      document = Promise.resolve(vscode.workspace.openTextDocument(uri)).then(
        value => value,
        () => null
      );
    } catch {
      document = Promise.resolve(null);
    }
    documents.set(key, document);
    return document;
  };
}

export function uniqueVscodeLocations(locations: readonly vscode.Location[]): vscode.Location[] {
  return [...new Map(locations.map(location => [
    `${location.uri.toString()}\0${location.range.start.line}\0${location.range.start.character}`
      + `\0${location.range.end.line}\0${location.range.end.character}`,
    location
  ])).values()];
}

export function uniqueOffsetLocations<T extends { uri: string; range?: { start: number; end: number } }>(
  locations: readonly T[]
): T[] {
  return [...new Map(locations.map(location => [
    `${location.uri}\0${location.range?.start ?? 0}\0${location.range?.end ?? 0}`,
    location
  ])).values()];
}

/** Bridges a VS Code cancellation token onto an AbortSignal. */
export function cancellationTokenToAbortSignal(token: vscode.CancellationToken): {
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
