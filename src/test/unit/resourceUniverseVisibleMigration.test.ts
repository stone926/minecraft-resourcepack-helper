import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

describe("resource universe visible migration contract", () => {
  it("routes physical Definition and graph resolution through one navigation facade", () => {
    const definition = readSource("providers", "resourceDefinitionProvider.ts");
    const locationBridge = readSource("utils", "resourceLocationVscode.ts");
    const graph = readSource("services", "resourceGraphService.ts");
    const facade = readSource("services", "resourceUniverseNavigationFacade.ts");
    const definitions = readSource("services", "resourceDefinitionQueryService.ts");
    const refresh = readSource("services", "projectRefreshCoordinator.ts");

    assert.ok(definition.includes("navigation.resolveReference(document, reference, {"));
    assert.ok(definition.includes("includeGenerated: true"));
    assert.ok(definition.includes("toVscodeLocations(locations, token)"));
    assert.ok(locationBridge.includes("document.positionAt(location.range.start)"));
    assert.ok(definition.includes("definitionLocationsForNavigation"));
    assert.strictEqual(definition.includes("generateReferenceRedirectPath"), false);
    assert.ok(graph.includes("navigation.getOutgoingReferences"));
    assert.ok(graph.includes("navigation.getIncomingReferences"));
    assert.ok(facade.includes("new ResourceNavigationService"));
    assert.ok(definitions.includes("resolveProducerDefinition"));
    assert.ok(refresh.includes("physicalProviderId"));
    assert.ok(refresh.includes("rsglGeneratedProviderId"));
    assert.ok(refresh.includes('applicability !== "none"'));
    assert.strictEqual(
      refresh.includes(".filter(providerId => this.universe.registry.get(providerId)"),
      false
    );
    assert.ok(facade.split(/\r?\n/u).length < 400, "the public facade must remain a thin composition root");
  });

  it("uses exact physical resolution and the Universe without a parallel legacy bridge", () => {
    const facade = readSource("services", "resourceUniverseNavigationFacade.ts");
    const references = readSource("services", "resourceReferenceQueryService.ts");
    const scanner = readSource("resourceUniverse", "providers", "vscodePhysicalAssetSource.ts");

    assert.strictEqual(facade.includes("legacyResolver"), false);
    assert.strictEqual(facade.includes("LegacyReferenceBridge"), false);
    assert.ok(facade.includes("referenceQueries.setPhysicalDefinitionResolver"));
    assert.ok(references.includes("resolveExactDefinition"));
    assert.ok(references.includes("this.navigation.resolveDefinition"));
    assert.ok(references.includes("if (modeResolution.handled)"));
    assert.strictEqual(
      references.includes("modeResolution.targetUri || !identity"),
      false,
      "specialized CIT misses must not fall through to logical Universe resolution"
    );
    assert.ok(scanner.includes("parsePackMetadata"));
    assert.ok(scanner.includes("overlayApplies"));
    assert.ok(scanner.includes("effectiveDocuments"));
    assert.strictEqual(scanner.includes('from "../../resourceProject"'), false);
    assert.ok(scanner.includes("PhysicalAssetProjectContextStore"));
  });

  it("keeps legacy graph indexing only as an unavailable coverage fallback", () => {
    const graph = readSource("services", "resourceGraphService.ts");

    assert.ok(graph.includes('result.coverage === "unavailable"'));
    assert.ok(graph.includes('result.coverage === "unavailable"'));
    assert.ok(graph.includes("this.index.getReferences"));
    assert.ok(graph.includes("this.index.getIncomingReferences"));
  });

  it("propagates target and metadata/config mutations into universe invalidation", () => {
    const workspaceEvents = readSource("registration", "registerWorkspaceEvents.ts");
    const infrastructure = readSource("registration", "registerResourceInfrastructure.ts");
    const graph = readSource("services", "resourceGraphService.ts");

    assert.ok(workspaceEvents.includes("resourceGraph.invalidatePath(uri, kind)"));
    assert.ok(graph.includes("this.navigation.invalidateUri"));
    assert.ok(infrastructure.includes("resourceProjectAnchorWatcherGlob"));
    assert.ok(infrastructure.includes("projectHost.invalidateWorkspaceFolders()"));
    assert.ok(infrastructure.includes("onDidChangeWorkspaceFolders"));
    assert.ok(infrastructure.includes("universe.removeProject(projectId)"));
  });

  it("registers coverage-safe physical-file References over merged Universe edges", () => {
    const registration = readSource("registration", "registerLanguageProviders.ts");
    const provider = readSource("providers", "resourceReferenceProvider.ts");

    assert.ok(registration.includes("registerReferenceProvider"));
    assert.ok(registration.includes("createResourceReferenceProvider(navigation)"));
    assert.ok(provider.includes("navigation.getIncomingReferences"));
    assert.ok(provider.includes("includeGenerated: true"));
    assert.ok(provider.includes('result.coverage === "unavailable"'));
    assert.ok(provider.includes("reference.sourceRange"));
  });

  it("keeps diagnostics generated-aware without scanning explicit non-RSGL directory projects", () => {
    const registration = readSource("registration", "registerResourceDiagnostics.ts");
    const references = readSource("services", "resourceReferenceQueryService.ts");

    assert.ok(registration.includes("navigation.resolveReference(document, reference, {"));
    assert.ok(registration.includes("includeGenerated: true"));
    assert.ok(references.includes("this.refreshCoordinator.discoverProjectForUri(document.uri)"));
    assert.ok(references.includes('coverage: "authoritative"'));
    assert.ok(
      references.indexOf("this.physicalDefinitionResolver.resolveExactDefinition")
        < references.indexOf("this.refreshCoordinator.refreshDiscoveredProject(discovered, options)")
    );
  });

  it("keeps RSGL generated providers inside the RSGL feature boundary", () => {
    const physicalProviders = readSource("resourceUniverse", "providers", "index.ts");
    const rsglProviders = readSource("rsgl", "provider", "index.ts");
    const formerDirectory = path.join(process.cwd(), "src", "resourceUniverse", "providers");

    assert.strictEqual(physicalProviders.includes("rsglGenerated"), false);
    for (const name of [
      "rsglGeneratedMaterialization.ts",
      "rsglGeneratedOwnershipManifest.ts",
      "rsglGeneratedProvider.ts",
      "rsglGeneratedProviderConnection.ts",
      "rsglGeneratedSnapshotMapper.ts"
    ]) {
      assert.strictEqual(fs.existsSync(path.join(formerDirectory, name)), false);
    }
    assert.ok(rsglProviders.includes('export * from "./rsglGeneratedProvider"'));
    assert.ok(rsglProviders.includes('export * from "./rsglGeneratedMaterialization"'));
  });
});

function readSource(...segments: string[]): string {
  return fs.readFileSync(path.join(process.cwd(), "src", ...segments), "utf8");
}
