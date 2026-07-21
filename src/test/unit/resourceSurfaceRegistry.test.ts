import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  getResourceDocumentSelectors,
  getResourceGraphDiscoveryGlob,
  getResourceIncomingReferenceRoots,
  getResourceGraphPreviewContext,
  getResourceGraphPreviewContexts,
  getResourceManifestWhenClauses,
  getResourceReferenceExtraction,
  getResourceReferenceTargets,
  getResourceSchemaRegistrations,
  getResourceSemanticDiagnosticsKind,
  getResourceStructureDiscoveryGlob,
  getResourceSurfaceDocumentKind,
  getResourceWatcherGlob,
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

  it("routes structural semantic diagnostics through typed surface metadata", () => {
    const semanticSurfaceDescriptors = resourceSurfaceRegistry
      .filter(surface => surface.semanticDiagnostics !== undefined);
    const semanticSurfaces = semanticSurfaceDescriptors
      .map(surface => ({ id: surface.id, kind: surface.semanticDiagnostics }))
      .sort((left, right) => left.id.localeCompare(right.id));

    assert.deepStrictEqual(semanticSurfaces, [
      { id: "models", kind: "model" },
      { id: "packMetadata", kind: "packMetadata" },
      { id: "postEffect", kind: "postEffect" },
      { id: "sounds", kind: "sounds" }
    ]);
    for (const surface of semanticSurfaceDescriptors) {
      assert.strictEqual(surface.language, "json", `${surface.id} must preserve the JSON language gate`);
      assert.ok(surface.fileNamePattern || surface.matchesFileName, `${surface.id} must declare a file-name matcher`);
    }

    assert.strictEqual(getResourceSemanticDiagnosticsKind(path.join("pack", "pack.mcmeta"), "json"), "packMetadata");
    assert.strictEqual(
      getResourceSemanticDiagnosticsKind(path.join("pack", "assets", "minecraft", "models", "block", "stone.json"), "json"),
      "model"
    );
    assert.strictEqual(
      getResourceSemanticDiagnosticsKind(path.join("pack", "assets", "minecraft", "post_effect", "blur.json"), "json"),
      "postEffect"
    );
    assert.strictEqual(
      getResourceSemanticDiagnosticsKind(path.join("pack", "assets", "minecraft", "sounds.json"), "json"),
      "sounds"
    );
    assert.strictEqual(getResourceSemanticDiagnosticsKind("C:\\pack\\pack.mcmeta", "json"), "packMetadata");
    assert.strictEqual(getResourceSemanticDiagnosticsKind(path.join("pack", "pack.mcmeta"), "plaintext"), null);
    assert.strictEqual(
      getResourceSemanticDiagnosticsKind(path.join("pack", "assets", "minecraft", "textures", "stone.png.mcmeta"), "json"),
      null
    );
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
      incomingReferenceRoots: [{ root: "fixtures" }],
      graphPreviewContext: "modelResource",
      fileNamePattern: /[\\/]fixture[\\/].+\.fixture$/i
    };
    const registry = [fixture];
    const fileName = path.join("pack", "assets", "example", "fixture", "sample.fixture");

    assert.deepStrictEqual(getResourceDocumentSelectors("completion", registry), [
      { language: "json", pattern: "**/fixture/**/*.fixture" }
    ]);
    assert.deepStrictEqual(getResourceWatcherPatterns(registry), ["**/fixture/**/*.fixture"]);
    assert.strictEqual(getResourceWatcherGlob(registry), "**/fixture/**/*.fixture");
    assert.strictEqual(getResourceWatcherGlob([
      { id: "first", watcherPatterns: ["**/*.first"] },
      { id: "second", watcherPatterns: ["**/*.second"] }
    ]), "{**/*.first,**/*.second}");
    assert.throws(
      () => getResourceWatcherGlob([{ id: "nested", watcherPatterns: ["**/*.{one,two}"] }]),
      /brace- and comma-free/
    );
    assert.throws(
      () => getResourceWatcherGlob([{ id: "comma", watcherPatterns: ["**/one,two/*.json"] }]),
      /brace- and comma-free/
    );
    assert.deepStrictEqual(getResourceSchemaRegistrations(registry), fixture.schema);
    assert.strictEqual(getResourceSurfaceDocumentKind(fileName, registry), "fixture");
    const fixtureExtraction = getResourceReferenceExtraction("fixture", registry);
    assert.strictEqual(fixtureExtraction?.mode, "json");
    assert.strictEqual(fixtureExtraction?.mode === "json" ? fixtureExtraction.extract : null, extractFixtureReferences);
    assert.deepStrictEqual(getResourceReferenceTargets("fixture", registry), ["model"]);
    assert.strictEqual(getResourceGraphDiscoveryGlob(registry), "**/assets/**/*.fixture");
    assert.deepStrictEqual(getResourceIncomingReferenceRoots(registry), [{ root: "fixtures" }]);
    assert.strictEqual(getResourceGraphPreviewContext(fileName, registry), "modelResource");
    assert.strictEqual(isResourceSurfaceFile(fileName, "graph", registry), true);
    assert.strictEqual(isResourceSurfaceFile(fileName, "diagnostics", registry), true);
  });

  it("watches non-JSON sound and font targets that participate in resolution", () => {
    const watcherPatterns = getResourceWatcherPatterns();
    const watcherGlob = getResourceWatcherGlob();

    assert.ok(watcherPatterns.includes("**/assets/*/sounds/**/*.ogg"));
    assert.ok(watcherPatterns.includes("**/assets/*/font/**/*"));
    assert.ok(watcherGlob);
    assert.ok(watcherGlob.startsWith("{") && watcherGlob.endsWith("}"));
    for (const pattern of watcherPatterns) {
      assert.ok(watcherGlob.includes(pattern), `combined watcher is missing ${pattern}`);
    }
    assert.strictEqual(getResourceWatcherGlob([]), undefined);
  });

  it("derives incoming reference roots and layered aliases from descriptors", () => {
    const roots = getResourceIncomingReferenceRoots();

    assert.ok(roots.some(root => root.root === "models"));
    assert.ok(roots.some(root => root.root === "textures/particle"));
    assert.ok(roots.some(root =>
      root.root === "textures/entity/equipment" && root.stripLeadingSegments === 1
    ));
    assert.ok(roots.some(root => root.root === "shaders/include"));
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
    assert.match(getResourceStructureDiscoveryGlob(), /pack\.mcmeta/);
    assert.match(getResourceStructureDiscoveryGlob(), /assets/);

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
