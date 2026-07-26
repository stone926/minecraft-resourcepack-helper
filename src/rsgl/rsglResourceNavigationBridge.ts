import * as vscode from "vscode";
import {
  isRsglResourceNavigationRequest,
  type RsglResourceNavigationLocationDto,
  type RsglResourceNavigationReason,
  type RsglResourceNavigationRequest,
  type RsglResourceNavigationResponse
} from "../../packages/rsgl-shared/src/resourceNavigationProtocol";
import { throwIfAborted } from "../utils/abortError";
import type {
  ResourceLocation,
  ResourceProducer
} from "../resourceUniverse/core/types";
import type { ResourceNavigationResult } from "../resourceUniverse/navigation/resourceNavigationService";
import { combineResourceFactsCoverage } from "../services/resourceFactsCoverage";
import type {
  ResourceUniverseNavigationFacade,
  UnifiedResourceCoverage
} from "../services/resourceUniverseNavigationFacade";

/** Main-extension endpoint for the LSP's server-to-client navigation request. */
export async function resolveRsglResourceNavigation(
  navigation: ResourceUniverseNavigationFacade,
  value: unknown,
  signal: AbortSignal
): Promise<RsglResourceNavigationResponse> {
  if (!isRsglResourceNavigationRequest(value)) {
    throw new TypeError("The RSGL resource navigation request failed its runtime guard.");
  }
  if (signal.aborted) {
    return response(value, "cancelled", "unavailable", [], "cancelled");
  }

  let sourceUri: vscode.Uri;
  try {
    sourceUri = vscode.Uri.parse(value.sourceContext.documentUri, true);
  } catch {
    return response(value, "unavailable", "unavailable", [], "noProject");
  }

  try {
    const result = value.operation === "definition"
      ? await resolveDefinition(navigation, sourceUri, value, signal)
      : await resolveReferences(navigation, sourceUri, value, signal);
    return result;
  } catch (error) {
    if (signal.aborted || isCancellationError(error)) {
      return response(value, "cancelled", "unavailable", [], "cancelled");
    }
    return response(value, "unavailable", "unavailable", [], "internalError");
  }
}

async function resolveDefinition(
  navigation: ResourceUniverseNavigationFacade,
  sourceUri: vscode.Uri,
  request: RsglResourceNavigationRequest,
  signal: AbortSignal
): Promise<RsglResourceNavigationResponse> {
  const result = await navigation.resolveLogicalDefinition(
    sourceUri,
    request.target,
    request.resolutionScope,
    { signal }
  );
  if (!result.context || !matchesRequestedProject(request, result.context.projectId)) {
    return response(request, "unavailable", result.coverage, [], "noProject");
  }
  if (request.declarationMode === "unchecked") {
    return response(
      request,
      "unchecked",
      result.coverage,
      [],
      "existenceCheckDisabled",
      result.context.projectId
    );
  }
  if (!result.navigation) {
    return response(request, "unavailable", result.coverage, [], "providerUnavailable", result.context.projectId);
  }
  return responseForNavigation(
    request,
    result.context.projectId,
    result.coverage,
    result.navigation,
    signal
  );
}

async function resolveReferences(
  navigation: ResourceUniverseNavigationFacade,
  sourceUri: vscode.Uri,
  request: RsglResourceNavigationRequest,
  signal: AbortSignal
): Promise<RsglResourceNavigationResponse> {
  const [incoming, definition] = await Promise.all([
    navigation.getLogicalIncomingReferenceLocations(sourceUri, request.target, { signal }),
    request.includeDeclaration && request.declarationMode !== "unchecked"
      ? navigation.resolveLogicalDefinition(
          sourceUri,
          request.target,
          request.resolutionScope,
          { signal }
        )
      : undefined
  ]);
  const context = incoming.context ?? definition?.context;
  const coverage = combineResourceFactsCoverage([incoming.coverage, definition?.coverage].filter(
    (item): item is UnifiedResourceCoverage => item !== undefined
  ));
  if (!context || !matchesRequestedProject(request, context.projectId)) {
    return response(request, "unavailable", coverage, [], "noProject");
  }
  const sourceLocations = [
    ...incoming.locations,
    ...(definition?.navigation ? locationsForNavigation(definition.navigation) : [])
  ];
  const locations = await toProtocolLocations(sourceLocations, signal);
  if (locations.length > 0) {
    return response(
      request,
      "resolved",
      coverage,
      locations,
      coverage === "authoritative" ? undefined : "resolutionIncomplete",
      context.projectId
    );
  }
  return coverage === "authoritative"
    ? response(request, "missing", coverage, [], "noProducer", context.projectId)
    : response(request, "incomplete", coverage, [], "providerUnavailable", context.projectId);
}

async function responseForNavigation(
  request: RsglResourceNavigationRequest,
  projectId: string,
  coverage: UnifiedResourceCoverage,
  navigation: ResourceNavigationResult,
  signal: AbortSignal
): Promise<RsglResourceNavigationResponse> {
  if (navigation.status === "resolved") {
    const locations = await toProtocolLocations(
      [navigation.primary, ...navigation.alternatives],
      signal
    );
    return response(
      request,
      "resolved",
      coverage,
      locations,
      navigation.resolutionIncomplete || coverage !== "authoritative"
        ? "resolutionIncomplete"
        : undefined,
      projectId
    );
  }
  if (navigation.status === "multiple" || navigation.status === "conflict") {
    const locations = await toProtocolLocations(
      navigation.candidates.flatMap(locationsForProducer),
      signal
    );
    if (locations.length === 0) {
      return response(
        request,
        coverage === "authoritative" ? "missing" : "incomplete",
        coverage,
        [],
        coverage === "authoritative" ? "noNavigableOrigin" : "providerUnavailable",
        projectId
      );
    }
    return response(
      request,
      navigation.status,
      coverage,
      locations,
      navigation.status === "conflict" ? "conflict" : undefined,
      projectId
    );
  }
  return response(
    request,
    navigation.status,
    coverage,
    [],
    navigation.reason,
    projectId
  );
}

function locationsForNavigation(navigation: ResourceNavigationResult): ResourceLocation[] {
  if (navigation.status === "resolved") {
    return [navigation.primary, ...navigation.alternatives];
  }
  if (navigation.status === "multiple" || navigation.status === "conflict") {
    return navigation.candidates.flatMap(locationsForProducer);
  }
  return [];
}

function locationsForProducer(producer: ResourceProducer): ResourceLocation[] {
  return [...producer.sourceOrigins, ...producer.physicalOrigins];
}

async function toProtocolLocations(
  locations: readonly ResourceLocation[],
  signal: AbortSignal
): Promise<RsglResourceNavigationLocationDto[]> {
  const converted = await Promise.all(locations.map(location => toProtocolLocation(location, signal)));
  return [...new Map(converted.map(location => [[
    location.uri,
    location.range?.start.line ?? "",
    location.range?.start.character ?? "",
    location.range?.end.line ?? "",
    location.range?.end.character ?? ""
  ].join("\0"), location])).values()];
}

async function toProtocolLocation(
  location: ResourceLocation,
  signal: AbortSignal
): Promise<RsglResourceNavigationLocationDto> {
  if (!location.range) {
    return { uri: location.uri, origin: location.origin };
  }
  throwIfAborted(signal, "Resource navigation was cancelled.");
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(location.uri, true));
    throwIfAborted(signal, "Resource navigation was cancelled.");
    const length = document.getText().length;
    return {
      uri: location.uri,
      origin: location.origin,
      range: {
        start: document.positionAt(Math.max(0, Math.min(length, location.range.start))),
        end: document.positionAt(Math.max(0, Math.min(length, location.range.end)))
      }
    };
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return { uri: location.uri, origin: location.origin };
  }
}

function response(
  request: RsglResourceNavigationRequest,
  status: RsglResourceNavigationResponse["status"],
  coverage: UnifiedResourceCoverage,
  locations: readonly RsglResourceNavigationLocationDto[],
  reason?: RsglResourceNavigationReason,
  projectId?: string
): RsglResourceNavigationResponse {
  return {
    protocolVersion: request.protocolVersion,
    requestGeneration: request.requestGeneration,
    operation: request.operation,
    ...(projectId ? { projectId } : {}),
    status,
    coverage,
    locations,
    ...(reason ? { reason } : {})
  };
}

function matchesRequestedProject(request: RsglResourceNavigationRequest, projectId: string): boolean {
  return request.sourceContext.projectId === undefined
    || request.sourceContext.projectId === projectId;
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /cancel/i.test(error.message));
}
