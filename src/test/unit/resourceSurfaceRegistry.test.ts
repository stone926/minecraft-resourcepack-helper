import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  getResourceDocumentSelectors,
  getResourceGraphDiscoveryGlob,
  getResourceGraphPreviewContext,
  getResourceGraphPreviewContexts,
  getResourceManifestWhenClauses,
  getResourceReferenceExtraction,
  getResourceReferenceTargets,
  getResourceSchemaRegistrations,
  getResourceSurfaceDocumentKind,
  getResourceWatcherPatterns,
  isResourceSurfaceFile,
  resourceSurfaceRegistry,
  type ResourceSchemaRegistration,
  type ResourceSurfaceDescriptor
} from "../../resources/resourceSurfaceRegistry";

describe("resource surface registry", () => {
  it("keeps manifest schema registrations consistent with the registry", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      contributes?: { jsonValidation?: ResourceSchemaRegistration[] };
    };
    const manifestSchemas = packageJson.contributes?.jsonValidation ?? [];
    const registrySchemas = getResourceSchemaRegistrations();

    assert.deepStrictEqual(sortSchemas(registrySchemas), sortSchemas(manifestSchemas));
  });

  it("derives every reference surface capability from one descriptor", () => {
    const referenceSurfaces = resourceSurfaceRegistry.filter(surface => surface.capabilities?.includes("references"));
    assert.ok(referenceSurfaces.length > 0);

    for (const surface of referenceSurfaces) {
      assert.ok(surface.documentKind, `${surface.id} should declare a document kind`);
      assert.ok(surface.selectorPatterns?.length, `${surface.id} should declare selectors`);
      assert.ok(surface.capabilities?.includes("completion"), `${surface.id} should enable completion`);
      assert.ok(surface.capabilities?.includes("diagnostics"), `${surface.id} should enable diagnostics`);
      assert.ok(surface.capabilities?.includes("graph"), `${surface.id} should enable graph scanning`);
      assert.ok(surface.graphFileExtensions?.length, `${surface.id} should declare graph discovery extensions`);
      assert.ok(surface.referenceExtraction, `${surface.id} should declare reference extraction`);
      assert.ok(surface.referenceTargets?.length, `${surface.id} should declare reference target metadata`);
    }
  });

  it("derives selector, watcher, graph, completion, diagnostics, and schema data for a fixture surface", () => {
    const extractFixtureReferences = () => [];
    const fixture: ResourceSurfaceDescriptor<"fixture"> = {
      id: "fixture",
      documentKind: "fixture",
      language: "json",
      selectorPatterns: ["**/fixture/**/*.fixture"],
      watcherPatterns: ["**/fixture/**/*.fixture"],
      schema: [{ fileMatch: "**/fixture/**/*.fixture", url: "%schema.fixture.url%" }],
      capabilities: ["references", "completion", "diagnostics", "graph"],
      referenceExtraction: { mode: "json", extract: extractFixtureReferences },
      referenceTargets: ["model"],
      graphFileExtensions: ["fixture"],
      graphPreviewContext: "modelResource",
      fileNamePattern: /[\\/]fixture[\\/].+\.fixture$/i
    };
    const registry = [fixture];
    const fileName = path.join("pack", "assets", "example", "fixture", "sample.fixture");

    assert.deepStrictEqual(getResourceDocumentSelectors("completion", registry), [
      { language: "json", pattern: "**/fixture/**/*.fixture" }
    ]);
    assert.deepStrictEqual(getResourceWatcherPatterns(registry), ["**/fixture/**/*.fixture"]);
    assert.deepStrictEqual(getResourceSchemaRegistrations(registry), fixture.schema);
    assert.strictEqual(getResourceSurfaceDocumentKind(fileName, registry), "fixture");
    const fixtureExtraction = getResourceReferenceExtraction("fixture", registry);
    assert.strictEqual(fixtureExtraction?.mode, "json");
    assert.strictEqual(fixtureExtraction?.mode === "json" ? fixtureExtraction.extract : null, extractFixtureReferences);
    assert.deepStrictEqual(getResourceReferenceTargets("fixture", registry), ["model"]);
    assert.strictEqual(getResourceGraphDiscoveryGlob(registry), "**/assets/**/*.fixture");
    assert.strictEqual(getResourceGraphPreviewContext(fileName, registry), "modelResource");
    assert.strictEqual(isResourceSurfaceFile(fileName, "graph", registry), true);
    assert.strictEqual(isResourceSurfaceFile(fileName, "diagnostics", registry), true);
  });

  it("keeps manifest menu resource clauses consistent with descriptors", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      contributes?: { menus?: Record<string, Array<{ when?: string }>> };
    };
    const manifestClauses = new Set(
      Object.values(packageJson.contributes?.menus ?? {})
        .flatMap(entries => entries.map(entry => entry.when).filter((when): when is string => Boolean(when)))
    );

    for (const clause of getResourceManifestWhenClauses()) {
      assert.ok(manifestClauses.has(clause), `Manifest is missing registry when clause: ${clause}`);
    }
    for (const contextValue of getResourceGraphPreviewContexts()) {
      assert.ok(
        [...manifestClauses].some(clause => clause.includes(`viewItem == ${contextValue}`)),
        `Manifest is missing registry graph context: ${contextValue}`
      );
    }
  });

  it("keeps runtime registration modules free of duplicated resource globs", () => {
    const registrationFiles = [
      path.join(process.cwd(), "src", "registration", "registerLanguageProviders.ts"),
      path.join(process.cwd(), "src", "registration", "registerWorkspaceEvents.ts")
    ];

    for (const fileName of registrationFiles) {
      const source = fs.readFileSync(fileName, "utf8");
      assert.strictEqual(source.includes("**/assets"), false, path.basename(fileName));
      assert.strictEqual(source.includes("**/models"), false, path.basename(fileName));
    }

    const graphScan = fs.readFileSync(
      path.join(process.cwd(), "src", "utils", "resourceGraphScan.ts"),
      "utf8"
    );
    assert.match(graphScan, /getResourceGraphDiscoveryGlob\(\)/);
    assert.strictEqual(graphScan.includes("{json,properties,vsh,fsh,glsl}"), false);
  });
});

function sortSchemas(schemas: readonly ResourceSchemaRegistration[]): ResourceSchemaRegistration[] {
  return [...schemas].sort((left, right) =>
    left.fileMatch.localeCompare(right.fileMatch) || left.url.localeCompare(right.url));
}
