import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("resource universe visible migration contract", () => {
  it("routes physical Definition and graph resolution through one navigation facade", () => {
    const definition = readSource("providers", "resourceDefinitionProvider.ts");
    const graph = readSource("services", "resourceGraphService.ts");
    const facade = readSource("services", "resourceUniverseNavigationFacade.ts");

    assert.ok(definition.includes("navigation.resolveReference(document, reference, {"));
    assert.ok(definition.includes("includeGenerated: true"));
    assert.ok(definition.includes("document.positionAt(location.range.start)"));
    assert.ok(definition.includes("navigation.primary, ...navigation.alternatives"));
    assert.strictEqual(definition.includes("generateReferenceRedirectPath"), false);
    assert.ok(graph.includes("navigation.getOutgoingReferences"));
    assert.ok(graph.includes("navigation.getIncomingReferences"));
    assert.ok(facade.includes("new ResourceNavigationService"));
    assert.ok(facade.includes("resolveProducerDefinition"));
  });

  it("keeps the established overlay/filter/load-order resolver as physical winner evidence", () => {
    const facade = readSource("services", "resourceUniverseNavigationFacade.ts");
    const scanner = readSource("resourceUniverse", "providers", "vscodePhysicalAssetSource.ts");

    assert.ok(facade.includes("legacyResolver"));
    assert.ok(facade.includes("generateReferenceRedirectPath"));
    assert.ok(facade.includes("findPhysicalProducer"));
    assert.ok(scanner.includes("parsePackMetadata"));
    assert.ok(scanner.includes("overlayApplies"));
    assert.ok(scanner.includes("effectiveDocuments"));
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
    assert.ok(infrastructure.includes('"**/rsgl.config.json"'));
    assert.ok(infrastructure.includes('"**/pack.mcmeta"'));
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
    const facade = readSource("services", "resourceUniverseNavigationFacade.ts");
    const policy = readSource("services", "referenceIndexRefreshPolicy.ts");

    assert.ok(registration.includes("navigation.resolveReference(document, reference, {"));
    assert.ok(registration.includes("includeGenerated: true"));
    assert.ok(policy.includes('input.rsglApplicability !== "none"'));
    assert.ok(policy.includes('source !== "directory"'));
    assert.ok(facade.includes("this.discoverProjectForUri(document.uri)"));
    assert.ok(facade.includes('coverage: "authoritative"'));
    assert.ok(
      facade.indexOf("requiresReferenceIndexRefresh({")
        < facade.indexOf("this.refreshDiscoveredProject(discovered, options)")
    );
  });
});

function readSource(...segments: string[]): string {
  return fs.readFileSync(path.join(process.cwd(), "src", ...segments), "utf8");
}
