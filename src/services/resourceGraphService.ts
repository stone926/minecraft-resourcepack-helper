import * as vscode from "vscode";
import { packRootFromAssetsPath } from "../../packages/mc-assets/src";
import type {
  ResourceUniverseNavigationFacade,
  UnifiedResolvedReference
} from "./resourceUniverseNavigationFacade";
import type { ResourceLocation, ResourceNavigationResult } from "../resourceUniverse";
import {
  loadResourceGraphDocument,
  ResourceGraphIndex,
  ResourceGraphWorkspaceCache,
  type ResourceGraphDocument,
  type ResourceGraphPathChangeKind
} from "../utils/resourceGraph";
import type {
  ResourceGraphTreeDocument,
  ResourceGraphBlockInventory,
  ResourceGraphDocumentProjection,
  ResourceGraphNodeNavigation,
  ResourceGraphProjectedResource,
  ResourceGraphTreeModelHost,
  ResourceGraphTreeResolvedReference,
  ResourceGraphUriLike
} from "../views/resourceGraphTreeModel";

export class ResourceGraphService implements ResourceGraphTreeModelHost {
  private readonly workspaceQuery = new ResourceGraphWorkspaceCache();
  private readonly index = new ResourceGraphIndex(this.workspaceQuery);

  public constructor(private readonly navigation: ResourceUniverseNavigationFacade) {}

  public invalidateAll(): void {
    this.index.invalidate();
    this.navigation.invalidateAllKnownProjects();
  }

  public invalidateDocument(document: ResourceGraphTreeDocument): void {
    this.index.invalidateDocument(toGraphDocument(document));
    this.navigation.invalidateUri(toVscodeUri(document.uri));
  }

  public invalidatePath(uri: ResourceGraphUriLike, kind: ResourceGraphPathChangeKind = "change"): void {
    this.index.invalidatePath(toVscodeUri(uri), kind);
    this.navigation.invalidateUri(toVscodeUri(uri));
  }

  public async getBlockstateInventory(): Promise<ResourceGraphBlockInventory> {
    let uris: readonly ResourceGraphUriLike[];
    try {
      uris = await this.workspaceQuery.getBlockstateUris();
    } catch (error) {
      return {
        status: "unknown",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
    const anchors = uniqueProjectAnchors(uris);
    const coverage = await Promise.all(anchors.map(uri =>
      this.navigation.ensureProjectForUri(toVscodeUri(uri))
    ));
    const generated = await this.navigation.getKnownBlockstateResources();
    const resources = generated.resources
      .filter(resource => resource.producer.origin === "generated")
      .map(resource => ({
        target: resource.target,
        producer: resource.producer,
        candidates: resource.candidates,
        resolutionStatus: resource.resolutionStatus
      } satisfies ResourceGraphProjectedResource));
    const incomplete = coverage.find(result => result.coverage !== "authoritative")
      ?? (generated.coverage === "authoritative" ? undefined : { coverage: generated.coverage });
    return incomplete
      ? {
          status: "partial",
          uris,
          resources,
          reason: incomplete.coverage === "partial"
            ? "Some resource providers or layers are unavailable."
            : "Project resource coverage is unavailable."
        }
      : { status: "authoritative", uris, resources };
  }

  public async getDocumentProjection(
    document: ResourceGraphTreeDocument
  ): Promise<ResourceGraphDocumentProjection> {
    const graphDocument = toGraphDocument(document);
    const result = await this.navigation.getDocumentProjection(graphDocument);
    return {
      applicable: result.applicable,
      providerIds: result.projections.map(projection => projection.providerId),
      coverage: result.coverage,
      resources: result.projections.flatMap(projection =>
        projection.resources.flatMap(projectResource)
      ),
      contributesTo: result.projections.flatMap(projection =>
        projection.contributesTo.flatMap(projectResource)
      )
    };

    function projectResource(producer: ResourceGraphProjectedResource["producer"]): ResourceGraphProjectedResource[] {
      const target = producer.logicalKeys[0];
      return target ? [{ target, producer }] : [];
    }
  }

  public async getReferences(
    document: ResourceGraphTreeDocument
  ): Promise<readonly ResourceGraphTreeResolvedReference[]> {
    const graphDocument = toGraphDocument(document);
    const result = await this.navigation.getOutgoingReferences(graphDocument, { includeGenerated: true });
    return result.coverage === "unavailable"
      ? this.index.getReferences(graphDocument)
      : result.references.map(toTreeReference);
  }

  public async getIncomingReferences(
    uri: ResourceGraphUriLike
  ): Promise<readonly ResourceGraphTreeResolvedReference[]> {
    const vscodeUri = toVscodeUri(uri);
    const result = await this.navigation.getIncomingReferences(vscodeUri, undefined, { includeGenerated: true });
    return result.coverage === "unavailable"
      ? this.index.getIncomingReferences(vscodeUri)
      : result.references.map(toTreeReference);
  }

  public async getChildModelReferences(
    uri: ResourceGraphUriLike
  ): Promise<readonly ResourceGraphTreeResolvedReference[]> {
    const vscodeUri = toVscodeUri(uri);
    const result = await this.navigation.getIncomingReferences(
      vscodeUri,
      "modelParent",
      { includeGenerated: true }
    );
    return result.coverage === "unavailable"
      ? this.index.getChildModelReferences(vscodeUri)
      : result.references.map(toTreeReference);
  }

  public async getProducerReferences(
    resource: ResourceGraphProjectedResource
  ): Promise<readonly ResourceGraphTreeResolvedReference[]> {
    const result = await this.navigation.getProducerOutgoingReferences(
      resource.producer.producerId,
      { includeGenerated: true }
    );
    return result.references.map(toTreeReference);
  }

  public async getProducerIncomingReferences(
    resource: ResourceGraphProjectedResource
  ): Promise<readonly ResourceGraphTreeResolvedReference[]> {
    const result = await this.navigation.getProducerIncomingReferences(
      resource.producer.producerId,
      undefined,
      { includeGenerated: true }
    );
    return result.references.map(toTreeReference);
  }

  public async getProducerChildModelReferences(
    resource: ResourceGraphProjectedResource
  ): Promise<readonly ResourceGraphTreeResolvedReference[]> {
    const result = await this.navigation.getProducerIncomingReferences(
      resource.producer.producerId,
      "modelParent",
      { includeGenerated: true }
    );
    return result.references.map(toTreeReference);
  }

  public async navigate(
    target: ResourceGraphNodeNavigation,
    options: { preferMaterialized?: boolean } = {}
  ): Promise<void> {
    if (target.kind === "location") {
      await openLocation(target.location);
      return;
    }
    const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
    if (target.kind === "producer") {
      const result = await this.navigation.resolveProducerNavigation(
        target.producerId,
        target.target,
        {
          includeGenerated: true,
          activeUri,
          preferMaterialized: options.preferMaterialized ?? target.preferMaterialized
        }
      );
      if (result) {
        await this.openNavigationResult(result, target.target);
      }
      return;
    }

    const uri = toVscodeUri(target.uri);
    const result = await this.navigation.resolveUriNavigation(uri, {
      includeGenerated: true,
      activeUri,
      preferMaterialized: options.preferMaterialized
    });
    if (result) {
      await this.openNavigationResult(result);
      return;
    }
    await openLocation({ uri: uri.toString(), origin: "physical" });
  }

  public async showConflictOwners(resource: ResourceGraphProjectedResource): Promise<void> {
    const candidates = resource.candidates?.length
      ? resource.candidates
      : [resource.producer];
    const selected = await pickProducer(candidates, vscode.l10n.t("Select a resource owner"));
    if (!selected) {
      return;
    }
    const target = selected.logicalKeys.find(key =>
      key.kind === resource.target.kind && key.id === resource.target.id
    ) ?? resource.target;
    const result = await this.navigation.resolveProducerNavigation(selected.producerId, target, {
      includeGenerated: true,
      activeUri: vscode.window.activeTextEditor?.document.uri.toString()
    });
    if (result) {
      await this.openNavigationResult(result, target);
    }
  }

  public configureVanillaSource(): Thenable<unknown> {
    return vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "McResHelper.defaultMcAssetsPath"
    );
  }

  public loadDocument(uri: ResourceGraphUriLike): Promise<ResourceGraphDocument> {
    return loadResourceGraphDocument(toVscodeUri(uri));
  }

  private async openNavigationResult(
    result: ResourceNavigationResult,
    target?: { kind: string; id: string }
  ): Promise<void> {
    if (result.status === "resolved") {
      const locations = [result.primary, ...result.alternatives];
      const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
      const selected = activeUri === result.primary.uri || locations.length === 1
        ? result.primary
        : await pickLocation(locations);
      if (selected) {
        await openLocation(selected);
      }
      return;
    }
    if (result.status === "multiple" || result.status === "conflict") {
      const selected = await pickProducer(
        result.candidates,
        result.status === "conflict"
          ? vscode.l10n.t("Select a conflicting resource owner")
          : vscode.l10n.t("Select a resource definition")
      );
      if (!selected) {
        return;
      }
      const logicalKey = target
        ?? selected.logicalKeys[0];
      if (!logicalKey) {
        return;
      }
      const selectedResult = await this.navigation.resolveProducerNavigation(
        selected.producerId,
        logicalKey,
        { includeGenerated: true }
      );
      if (selectedResult?.status === "resolved") {
        await openLocation(selectedResult.primary);
      }
      return;
    }
    if (result.candidates.length > 0) {
      const producer = result.candidates[0];
      const logicalKey = target ?? producer.logicalKeys[0];
      if (logicalKey) {
        const selectedResult = await this.navigation.resolveProducerNavigation(
          producer.producerId,
          logicalKey,
          { includeGenerated: true }
        );
        if (selectedResult?.status === "resolved") {
          await openLocation(selectedResult.primary);
          return;
        }
      }
    }
    const configure = vscode.l10n.t("Configure Vanilla Source");
    if (await vscode.window.showWarningMessage(
      vscode.l10n.t("No navigable resource definition is available."),
      configure
    ) === configure) {
      await this.configureVanillaSource();
    }
  }
}

function uniqueProjectAnchors(uris: readonly ResourceGraphUriLike[]): ResourceGraphUriLike[] {
  const anchors = new Map<string, ResourceGraphUriLike>();
  for (const uri of uris) {
    const packRoot = uri.scheme === "file" ? packRootFromAssetsPath(uri.fsPath) : null;
    const key = packRoot ?? uri.toString();
    if (!anchors.has(key)) {
      anchors.set(key, uri);
    }
  }
  return [...anchors.values()];
}

function toGraphDocument(document: ResourceGraphTreeDocument): ResourceGraphDocument {
  return document.uri instanceof vscode.Uri
    ? document as ResourceGraphDocument
    : { ...document, uri: toVscodeUri(document.uri) };
}

function toVscodeUri(uri: ResourceGraphUriLike): vscode.Uri {
  return uri instanceof vscode.Uri ? uri : vscode.Uri.parse(uri.toString(), true);
}

function toTreeReference(reference: UnifiedResolvedReference): ResourceGraphTreeResolvedReference {
  return {
    reference: reference.reference,
    sourceUri: reference.sourceUri,
    targetUri: reference.targetUri,
    target: reference.target,
    sourceRange: reference.sourceRange,
    sourceResource: reference.sourceProducer
      ? projectedProducer(reference.sourceProducer)
      : undefined,
    targetResource: reference.targetProducer
      ? projectedProducer(reference.targetProducer, reference.target)
      : undefined
  };
}

function projectedProducer(
  producer: ResourceGraphProjectedResource["producer"],
  preferredTarget?: ResourceGraphProjectedResource["target"]
): ResourceGraphProjectedResource | undefined {
  const target = preferredTarget ?? producer.logicalKeys[0];
  return target ? { target, producer } : undefined;
}

async function pickLocation(locations: readonly ResourceLocation[]): Promise<ResourceLocation | undefined> {
  const selected = await vscode.window.showQuickPick(locations.map(location => ({
    label: vscode.Uri.parse(location.uri, true).path.split("/").pop() ?? location.uri,
    description: location.origin,
    detail: location.range
      ? `${location.uri} · ${location.range.start}–${location.range.end}`
      : location.uri,
    location
  })), { placeHolder: vscode.l10n.t("Select a resource origin") });
  return selected?.location;
}

async function pickProducer(
  producers: readonly ResourceGraphProjectedResource["producer"][],
  placeHolder: string
): Promise<ResourceGraphProjectedResource["producer"] | undefined> {
  const selected = await vscode.window.showQuickPick(producers.map(producer => ({
    label: producer.logicalKeys.map(key => `${key.kind} ${key.id}`).join(", ") || producer.producerId,
    description: `${producer.origin} · ${producer.materializationState}`,
    detail: [
      producer.outputPath,
      ...producer.sourceOrigins.map(origin => origin.uri),
      ...producer.physicalOrigins.map(origin => origin.uri)
    ].filter((value): value is string => !!value).join(" · "),
    producer
  })), { placeHolder });
  return selected?.producer;
}

async function openLocation(location: ResourceLocation): Promise<void> {
  const uri = vscode.Uri.parse(location.uri, true);
  if (!location.range && !isTextResource(uri)) {
    await vscode.commands.executeCommand("vscode.open", uri);
    return;
  }
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    if (location.range) {
      const range = new vscode.Range(
        document.positionAt(location.range.start),
        document.positionAt(location.range.end)
      );
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  } catch {
    await vscode.commands.executeCommand("vscode.open", uri);
  }
}

function isTextResource(uri: vscode.Uri): boolean {
  return /\.(?:json|mcmeta|properties|rsgl|vsh|fsh|glsl|txt|lang)$/i.test(uri.path);
}
