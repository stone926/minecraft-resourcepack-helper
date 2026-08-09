import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ResourceGraphLogicalKey } from "../../../packages/mc-assets/src";
import {
  compileRsglResourceAnalysis,
  createRsglResourceSnapshot,
  emitRsglFiles,
  hashRsglOwnedContent,
  loadRsglSourceFilesFromDirectory,
  nodeAsyncMaterializationHost,
  runRsglMaterializationTransaction
} from "../../../packages/rsgl-core/src";
import {
  RsglGeneratedProvider,
  projectRsglGeneratedOwnershipManifest
} from "../../rsgl/provider";
import {
  ResourceNavigationService,
  ResourceUniverseIndex,
  type ResourceContributionRequest,
  type ResourceEdge,
  type ResourceNavigationResult,
  type ResourceResolutionContext
} from "../../resourceUniverse";
import { ZipArchive } from "../../resourceUniverse/virtualFs";
import {
  CompilerSnapshotSource,
  createMixedPhysicalSnapshot as physicalSnapshot,
  findPackRoot,
  fixturePath,
  mixedWorkflow as workflow,
  mixedWorkflowTarget as target,
  readMixedGolden as readGolden,
  resolveExternFixture,
  slash,
  type MixedFixtureGolden
} from "./helpers/mixedResourceWorkflowFixture";
import { createZipFixture } from "../helpers/zipFixture";

describe("mixed RSGL/resource-pack workflows", () => {
  it("executes all five fixture workflows through compiler, Universe, ZIP, navigation, and materialization", async () => {
    const fixtureSource = path.resolve("test/fixtures/resource-project/mixed-pack");
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mcres-mixed-workflows-"));
    const fixtureRoot = path.join(temporaryDirectory, "mixed-pack");
    fs.cpSync(fixtureSource, fixtureRoot, { recursive: true });

    try {
      const golden = readGolden(fixtureRoot);
      assert.deepStrictEqual(golden.workflows.map(workflow => workflow.id), [
        "rsgl-build-to-assets",
        "rsgl-to-local",
        "rsgl-to-vanilla",
        "assets-to-unbuilt-rsgl",
        "both-to-custom"
      ]);

      const projectRoot = fixturePath(fixtureRoot, "project");
      const sourceRoot = fixturePath(fixtureRoot, golden.project.sourceRoot);
      const archivePath = fixturePath(fixtureRoot, golden.archive.path);
      const archiveBytes = createZipFixture(golden.archive.entries);
      fs.writeFileSync(archivePath, archiveBytes);
      const archive = ZipArchive.fromBytes(archiveBytes);
      const archiveEntryPath = "assets/external/models/block/shared_custom.json";
      const archiveModelText = Buffer.from(archive.readFile(archiveEntryPath)).toString("utf8");
      assert.strictEqual(JSON.parse(archiveModelText).fixture_origin, "custom-zip-shadowed");

      const sourceFiles = loadRsglSourceFilesFromDirectory(sourceRoot);
      const analysis = compileRsglResourceAnalysis(sourceFiles, {
        checkExternExistence: true,
        externResourceResolution: (source, kind, id) => {
          const resolved = resolveExternFixture(fixtureRoot, source, kind, id);
          return {
            resolvedPath: resolved,
            candidatePaths: resolved ? [resolved] : [],
            metadataPaths: resolved ? [path.join(findPackRoot(resolved), "pack.mcmeta")] : []
          };
        }
      });
      assert.deepStrictEqual(
        analysis.compileResult.diagnostics.filter(diagnostic => diagnostic.severity === "error"),
        []
      );
      const compilerSnapshot = createRsglResourceSnapshot(analysis, {
        projectId: golden.project.id,
        analysisRevision: "mixed-fixture-source-r1"
      });
      assert.deepStrictEqual(
        compilerSnapshot.resources.map(resource => resource.logicalKeys[0]?.id).sort(),
        [
          "demo:block/generated_custom",
          "demo:block/generated_live",
          "demo:block/generated_vanilla",
          "demo:block/nested_generated"
        ]
      );
      assertCompilerResolvedTargets(compilerSnapshot, golden, fixtureRoot);

      const generatedProvider = new RsglGeneratedProvider(
        new CompilerSnapshotSource(compilerSnapshot),
        { localLayerIdForProject: () => "local" }
      );
      const generatedBeforeBuild = await generatedProvider.getSnapshot(
        contributionRequest(golden.project.id, 1),
        new AbortController().signal
      );
      const archiveUri = `mcres-archive://mixed-custom-zip/${archiveEntryPath}`;
      const physicalBeforeBuild = physicalSnapshot(
        fixtureRoot,
        golden.project.id,
        archiveModelText,
        archiveUri,
        1
      );
      const universe = new ResourceUniverseIndex();
      assert.strictEqual(
        universe.replaceSnapshotsAtomically([generatedBeforeBuild, physicalBeforeBuild]),
        true
      );
      const navigation = new ResourceNavigationService(universe);

      assertUnbuiltGeneratedWorkflow(golden, fixtureRoot, universe, navigation);
      assertLocalWorkflow(golden, fixtureRoot, universe, navigation);
      assertVanillaWorkflow(golden, fixtureRoot, universe, navigation);
      assertAssetsToGeneratedWorkflow(golden, fixtureRoot, universe, navigation);
      assertCustomWorkflow(golden, fixtureRoot, archiveUri, universe, navigation);
      assertGoldenEdges(golden, universe);

      const materializationProject = {
        projectId: golden.project.id,
        sourceRoot: "rsgl/src",
        outputPackRootIdentity: "mixed-fixture-local-layer"
      };
      const materialization = await runRsglMaterializationTransaction({
        files: emitRsglFiles(analysis.compileResult.units),
        outputRoot: projectRoot,
        project: materializationProject,
        sourceRootPath: sourceRoot,
        transactionId: "mixed-fixture-build"
      }, nodeAsyncMaterializationHost);
      assert.strictEqual(materialization.status, "committed");
      assert.strictEqual(materialization.manifestCommitted, true);
      assert.strictEqual(materialization.invalidation?.state, "committed");
      assert.strictEqual(materialization.invalidation?.projectId, golden.project.id);
      const buildWorkflow = workflow(golden, "rsgl-build-to-assets");
      assert.ok(buildWorkflow.build.destination);
      const buildOutputPath = slash(path.relative(
        projectRoot,
        fixturePath(fixtureRoot, buildWorkflow.build.destination)
      ));
      assert.ok(materialization.changedPaths.includes(buildOutputPath));
      assert.strictEqual(fs.existsSync(fixturePath(fixtureRoot, buildWorkflow.build.destination)), true);

      const manifestText = fs.readFileSync(materialization.preview.manifestPath, "utf8");
      const outputHashes = new Map(materialization.preview.manifest.files.map(file => [
        file.outputPath,
        hashRsglOwnedContent(fs.readFileSync(path.join(projectRoot, ...file.outputPath.split("/"))))
      ]));
      const ownershipSnapshot = projectRsglGeneratedOwnershipManifest(manifestText, {
        canonicalProjectId: golden.project.id,
        ownershipProjectId: golden.project.id,
        ownershipRevision: materialization.invalidation!.ownershipRevision,
        outputPackRootUri: pathToFileURL(projectRoot).toString(),
        actualContentHashes: outputHashes
      });
      assert.strictEqual(generatedProvider.replaceMaterializations(ownershipSnapshot), true);

      const generatedAfterBuild = await generatedProvider.getSnapshot(
        contributionRequest(golden.project.id, 2),
        new AbortController().signal
      );
      const physicalAfterBuild = physicalSnapshot(
        fixtureRoot,
        golden.project.id,
        archiveModelText,
        archiveUri,
        2,
        generatedProvider.getOwnedOutputPaths(golden.project.id)
      );
      assert.strictEqual(
        universe.replaceSnapshotsAtomically([generatedAfterBuild, physicalAfterBuild]),
        true
      );
      assert.strictEqual(universe.getSnapshotGeneration("rsgl", golden.project.id), 2);
      assert.strictEqual(universe.getSnapshotGeneration("physical", golden.project.id), 2);

      const generatedTarget = target(workflow(golden, "rsgl-build-to-assets"));
      const generatedProducers = universe.getProducersForKey(generatedTarget);
      assert.strictEqual(generatedProducers.length, buildWorkflow.graph.nodeCountAfterBuild);
      assert.strictEqual(generatedProducers[0].providerId, "rsgl");
      assert.strictEqual(generatedProducers[0].materializationState, "current");
      assert.deepStrictEqual(
        generatedProducers[0].sourceOrigins.map(origin => origin.origin),
        ["generated"]
      );
      assert.deepStrictEqual(
        generatedProducers[0].physicalOrigins.map(origin => origin.origin),
        ["materialized"]
      );
      assert.strictEqual(
        physicalAfterBuild.producers.some(producer =>
          producer.outputPath === buildOutputPath),
        false,
        "manifest-owned output must not re-enter the Universe as handwritten"
      );

      const afterBuildDefinition = resolved(navigation.resolveDefinition(
        generatedTarget,
        context(golden.project.id, "effective")
      ));
      assertFileLocation(afterBuildDefinition.primary.uri, fixtureRoot, buildWorkflow.definition.primaryUri);
      assert.deepStrictEqual(afterBuildDefinition.alternatives.map(location => location.uri), [
        pathToFileURL(fixturePath(fixtureRoot, buildWorkflow.build.destination)).toString()
      ]);
      const generatedJson = JSON.parse(fs.readFileSync(
        fixturePath(fixtureRoot, buildWorkflow.build.destination),
        "utf8"
      )) as { parent?: string };
      assert.strictEqual(generatedJson.parent, "demo:block/handwritten");
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

function assertUnbuiltGeneratedWorkflow(
  golden: MixedFixtureGolden,
  fixtureRoot: string,
  universe: ResourceUniverseIndex,
  navigation: ResourceNavigationService
): void {
  const expected = workflow(golden, "rsgl-build-to-assets");
  const definition = resolved(navigation.resolveDefinition(
    target(expected),
    context(golden.project.id, "effective")
  ));
  assert.strictEqual(definition.producer.providerId, "rsgl");
  assert.strictEqual(definition.producer.materializationState, "unbuilt");
  assertFileLocation(definition.primary.uri, fixtureRoot, expected.definition.primaryUri);
  assertSourceAnchor(definition, expected.definition.anchor!);
  assert.strictEqual(universe.getProducersForKey(target(expected)).length, 1);
}

function assertLocalWorkflow(
  golden: MixedFixtureGolden,
  fixtureRoot: string,
  universe: ResourceUniverseIndex,
  navigation: ResourceNavigationService
): void {
  const expected = workflow(golden, "rsgl-to-local");
  const definition = resolved(navigation.resolveDefinition(
    target(expected),
    context(golden.project.id, "local")
  ));
  assert.strictEqual(definition.producer.providerId, "physical");
  assert.strictEqual(definition.producer.layerRole, "local");
  assert.strictEqual(definition.producer.materializationState, "handwritten");
  assertFileLocation(definition.primary.uri, fixtureRoot, expected.definition.primaryUri);
  assert.strictEqual(universe.resolve(target(expected), context(golden.project.id, "local")).status, "resolved");
}

function assertVanillaWorkflow(
  golden: MixedFixtureGolden,
  fixtureRoot: string,
  universe: ResourceUniverseIndex,
  navigation: ResourceNavigationService
): void {
  const expected = workflow(golden, "rsgl-to-vanilla");
  const definition = resolved(navigation.resolveDefinition(
    target(expected),
    context(golden.project.id, "vanilla")
  ));
  assert.strictEqual(definition.producer.layerId, "vanilla-directory");
  assert.strictEqual(definition.primary.editable, false);
  assertFileLocation(definition.primary.uri, fixtureRoot, expected.definition.primaryUri);
  assert.strictEqual(universe.resolve(target(expected), context(golden.project.id, "vanilla")).status, "resolved");
}

function assertAssetsToGeneratedWorkflow(
  golden: MixedFixtureGolden,
  fixtureRoot: string,
  universe: ResourceUniverseIndex,
  navigation: ResourceNavigationService
): void {
  const expected = workflow(golden, "assets-to-unbuilt-rsgl");
  const definition = resolved(navigation.resolveDefinition(
    target(expected),
    context(golden.project.id, "effective")
  ));
  assert.strictEqual(definition.producer.providerId, "rsgl");
  assert.strictEqual(definition.producer.materializationState, "unbuilt");
  assertFileLocation(definition.primary.uri, fixtureRoot, expected.definition.primaryUri);
  assert.ok(universe.getIncoming(target(expected)).some(edge =>
    sourceKey(universe, edge) === "model|demo:block/handwritten_consumer"
    && edge.resolutionScope === "effective"));
}

function assertCustomWorkflow(
  golden: MixedFixtureGolden,
  fixtureRoot: string,
  archiveUri: string,
  universe: ResourceUniverseIndex,
  navigation: ResourceNavigationService
): void {
  const expected = workflow(golden, "both-to-custom");
  const resolution = universe.resolve(target(expected), context(golden.project.id, "custom"));
  assert.strictEqual(resolution.status, "resolved");
  assert.deepStrictEqual(resolution.candidates.map(candidate => candidate.producer.layerId), [
    "custom-directory",
    "custom-zip"
  ]);
  assert.ok(resolution.candidates.some(candidate =>
    candidate.producer.physicalOrigins[0]?.uri === archiveUri));
  const definition = resolved(navigation.resolveDefinition(
    target(expected),
    context(golden.project.id, "custom")
  ));
  assert.strictEqual(definition.producer.layerId, "custom-directory");
  assertFileLocation(definition.primary.uri, fixtureRoot, expected.definition.primaryUri);
}

function assertGoldenEdges(golden: MixedFixtureGolden, universe: ResourceUniverseIndex): void {
  for (const expectedWorkflow of golden.workflows) {
    const actual = universe.getIncoming(target(expectedWorkflow)).map(edge => ({
      from: sourceKey(universe, edge),
      to: logicalKey(edge.target),
      relationship: normalizeRelationship(edge.relationship),
      scope: edge.resolutionScope
    }));
    for (const expectedEdge of expectedWorkflow.graph.edges) {
      assert.ok(actual.some(edge =>
        edge.from === expectedEdge.from
        && edge.to === expectedEdge.to
        && edge.relationship === expectedEdge.relationship
        && edge.scope === expectedEdge.scope), `Missing mixed-workflow edge ${JSON.stringify(expectedEdge)}`);
    }
  }
  assert.ok(universe.getIncoming({ kind: "model", id: "demo:block/generated_live" }).some(edge =>
    sourceKey(universe, edge) === "model|demo:block/nested_generated"
    && edge.resolutionScope === "effective"), "real nested RSGL source must contribute its generated edge");
}

function assertCompilerResolvedTargets(
  snapshot: ReturnType<typeof createRsglResourceSnapshot>,
  golden: MixedFixtureGolden,
  fixtureRoot: string
): void {
  for (const [workflowId, scope] of [
    ["rsgl-to-local", "local"],
    ["rsgl-to-vanilla", "vanilla"],
    ["both-to-custom", "custom"]
  ] as const) {
    const expected = workflow(golden, workflowId);
    const edge = snapshot.edges.find(candidate =>
      logicalKey(candidate.target) === expected.logicalTarget.key
      && candidate.resolutionScope === scope);
    assert.ok(edge, `Compiler snapshot omitted the ${scope} extern edge`);
    assert.strictEqual(edge.resolvedTarget.status, "physical");
    assert.strictEqual(edge.resolvedTarget.source, scope);
    assert.ok(edge.resolvedTarget.uri);
    assertFileLocation(edge.resolvedTarget.uri, fixtureRoot, expected.winner.uri);
  }

  const nestedEdge = snapshot.edges.find(edge => {
    const producer = snapshot.resources.find(resource => resource.producerId === edge.sourceProducerId);
    return producer?.logicalKeys[0]?.id === "demo:block/nested_generated"
      && edge.target.id === "demo:block/generated_live";
  });
  assert.ok(nestedEdge);
  assert.strictEqual(nestedEdge.resolvedTarget.status, "generated");
}

function context(
  projectId: string,
  scope: ResourceResolutionContext["scope"]
): ResourceResolutionContext {
  return {
    contextId: `${projectId}:${scope}`,
    projectId,
    scope,
    orderedLayerIds: ["local", "custom-directory", "custom-zip", "vanilla-directory"],
    applicableProviderIds: ["rsgl", "physical"]
  };
}

function contributionRequest(projectId: string, requestGeneration: number): ResourceContributionRequest {
  return {
    projectId,
    scope: { projectId },
    requestGeneration
  };
}

function resolved(result: ResourceNavigationResult): Extract<ResourceNavigationResult, { status: "resolved" }> {
  if (result.status !== "resolved") {
    assert.fail(`Expected a resolved Definition, got ${result.status}`);
  }
  return result;
}

function assertSourceAnchor(
  definition: Extract<ResourceNavigationResult, { status: "resolved" }>,
  anchor: string
): void {
  assert.ok(definition.primary.range);
  const source = fs.readFileSync(fileURLToPath(definition.primary.uri), "utf8");
  const declaration = source.slice(
    definition.primary.range.start,
    definition.primary.range.end
  );
  assert.ok(declaration.length > 0);
  assert.ok(anchor.includes(declaration) || declaration.includes(anchor.split(" ").at(-1)!));
}

function assertFileLocation(actualUri: string, fixtureRoot: string, expectedRelativePath: string): void {
  assert.strictEqual(
    path.resolve(fileURLToPath(actualUri)),
    path.resolve(fixturePath(fixtureRoot, expectedRelativePath))
  );
}

function sourceKey(universe: ResourceUniverseIndex, edge: ResourceEdge): string {
  const source = universe.getProducer(edge.sourceProducerId);
  assert.ok(source, `Missing source producer ${edge.sourceProducerId}`);
  assert.ok(source.logicalKeys[0], `Source producer ${edge.sourceProducerId} has no logical key`);
  return logicalKey(source.logicalKeys[0]);
}

function normalizeRelationship(relationship: string | undefined): string {
  return relationship === "modelInheritance" || relationship === "modelParent"
    ? "model-parent"
    : relationship ?? "resource-reference";
}

function logicalKey(value: ResourceGraphLogicalKey): string {
  return `${value.kind}|${value.id}`;
}
