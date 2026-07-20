import * as vscode from "vscode";
import { lm } from "../i18n/messages";
import { localize } from "../i18n/runtime";
import { createResourceReferencePathResolver } from "../utils/pathGenerator";
import { getResourceReferences, isResourceReferenceDocument } from "../utils/resourceReferences";
import { rangeInsideString } from "../utils/resourceRange";
import { getCitDiagnostics } from "../cit/citDiagnostics";
import {
  DiagnosticsRefreshGate,
  type DiagnosticsRefresh
} from "./diagnosticsRefreshGate";
import {
  shouldReportMissingResource,
  type ResourceDiagnosticCoverage
} from "./resourceDiagnosticResolution";
import { getSemanticResourceDiagnostics } from "./semanticDiagnostics";
import { isSemanticDiagnosticsDocument } from "./semanticDiagnosticsCore";

const resolveResourcePath = createResourceReferencePathResolver();
const refreshGates = new WeakMap<vscode.DiagnosticCollection, DiagnosticsRefreshGate>();
const disposedCollections = new WeakSet<vscode.DiagnosticCollection>();

export interface ResourceDiagnosticResolution {
  readonly targetUri: vscode.Uri | null;
  readonly coverage: ResourceDiagnosticCoverage;
}

export type ResourceDiagnosticResolver = (
  document: vscode.TextDocument,
  reference: ReturnType<typeof getResourceReferences>[number]
) => Promise<ResourceDiagnosticResolution>;

export async function refreshResourceDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
  resolveReference?: ResourceDiagnosticResolver
): Promise<void> {
  if (disposedCollections.has(collection)) {
    return;
  }

  if (document.isClosed) {
    clearResourceDiagnostics(document, collection);
    return;
  }

  const refresh = getRefreshGate(collection).begin(document.uri.toString(), document.version);
  if (!isResourceReferenceDocument(document) && !isSemanticDiagnosticsDocument(document)) {
    clearResourceDiagnostics(document, collection);
    return;
  }

  const semanticDiagnostics = await getSemanticResourceDiagnostics(document);
  if (!isCurrentRefresh(document, collection, refresh)) {
    return;
  }

  const diagnostics: vscode.Diagnostic[] = [
    ...semanticDiagnostics,
    ...getCitDiagnostics(document, {
      onResourceIdsReady: () => {
        void refreshResourceDiagnostics(document, collection, resolveReference);
      }
    })
  ];

  for (const reference of getResourceReferences(document)) {
    if (reference.value.length === 0 || reference.value.startsWith("#")) {
      continue;
    }

    const resolution = resolveReference
      ? await resolveReference(document, reference)
      : {
          targetUri: resolveResourcePath(reference, document),
          coverage: "authoritative" as const
        };
    if (!isCurrentRefresh(document, collection, refresh)) {
      return;
    }
    const range = rangeInsideString(reference.valueNode);
    if (shouldReportMissingResource({
      resolved: resolution.targetUri !== null,
      coverage: resolution.coverage
    }) && range) {
      diagnostics.push(new vscode.Diagnostic(
        range,
        localize(lm("Minecraft resource not found: {0}", reference.value)),
        vscode.DiagnosticSeverity.Warning
      ));
    }
  }

  if (isCurrentRefresh(document, collection, refresh)) {
    collection.set(document.uri, diagnostics);
  }
}

export function clearResourceDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): void {
  refreshGates.get(collection)?.clear(document.uri.toString());
  collection.delete(document.uri);
}

export function disposeResourceDiagnosticsRefreshes(collection: vscode.DiagnosticCollection): void {
  refreshGates.get(collection)?.clearAll();
  refreshGates.delete(collection);
  disposedCollections.add(collection);
}

function getRefreshGate(collection: vscode.DiagnosticCollection): DiagnosticsRefreshGate {
  let gate = refreshGates.get(collection);
  if (!gate) {
    gate = new DiagnosticsRefreshGate();
    refreshGates.set(collection, gate);
  }
  return gate;
}

function isCurrentRefresh(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
  refresh: DiagnosticsRefresh
): boolean {
  return refreshGates.get(collection)?.isCurrent(refresh, document.version, document.isClosed) ?? false;
}
