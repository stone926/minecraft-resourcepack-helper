import type { Location } from "vscode-languageserver/node";
import {
  isRsglResourceNavigationResponse,
  rsglResourceNavigationProtocolVersion,
  type RsglResourceNavigationOperation,
  type RsglResourceNavigationRequest,
  type RsglResourceNavigationResponse
} from "../../rsgl-shared/src";
import type { RsglResourceNavigationTargetSelection } from "./resourceNavigationTarget";

export function createResourceNavigationRequest(
  operation: RsglResourceNavigationOperation,
  requestGeneration: number,
  documentUri: string,
  selection: RsglResourceNavigationTargetSelection,
  options: { sourceRootUri?: string; projectId?: string; includeDeclaration?: boolean } = {}
): RsglResourceNavigationRequest {
  return {
    protocolVersion: rsglResourceNavigationProtocolVersion,
    requestGeneration,
    operation,
    sourceContext: {
      documentUri,
      ...(options.sourceRootUri ? { sourceRootUri: options.sourceRootUri } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {})
    },
    target: selection.target,
    resolutionScope: selection.resolutionScope,
    declarationMode: selection.declarationMode,
    ...(operation === "references"
      ? { includeDeclaration: options.includeDeclaration === true }
      : {})
  };
}

/** Rejects malformed, mismatched, or stale replies before exposing locations. */
export function requireMatchingResourceNavigationResponse(
  value: unknown,
  request: RsglResourceNavigationRequest
): RsglResourceNavigationResponse {
  if (!isRsglResourceNavigationResponse(value)) {
    throw new TypeError("The RSGL resource navigation response failed its runtime guard.");
  }
  if (value.requestGeneration !== request.requestGeneration || value.operation !== request.operation) {
    throw new TypeError("The RSGL resource navigation response does not match its request.");
  }
  return value;
}

export function toLspResourceNavigationLocations(
  response: RsglResourceNavigationResponse
): Location[] {
  return response.locations.map(location => ({
    uri: location.uri,
    range: location.range ?? {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 }
    }
  }));
}

export function mergeLspResourceLocations(
  groups: readonly (readonly Location[])[]
): Location[] {
  const unique = new Map<string, Location>();
  for (const location of groups.flat()) {
    unique.set([
      location.uri,
      location.range.start.line,
      location.range.start.character,
      location.range.end.line,
      location.range.end.character
    ].join("\0"), location);
  }
  return [...unique.values()].sort((left, right) =>
    left.uri.localeCompare(right.uri, "en")
    || left.range.start.line - right.range.start.line
    || left.range.start.character - right.range.start.character
    || left.range.end.line - right.range.end.line
    || left.range.end.character - right.range.end.character
  );
}
