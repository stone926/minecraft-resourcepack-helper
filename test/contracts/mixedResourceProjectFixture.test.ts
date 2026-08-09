import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createDeterministicStoredZip,
  readDeterministicStoredZip,
  type DeterministicZipEntry
} from "../helpers/deterministicZip";

type WorkflowScope = "generated" | "local" | "vanilla" | "effective" | "custom";

interface MixedProjectGolden {
  schemaVersion: number;
  project: {
    id: string;
    configFile: string;
    packRoot: string;
    assetsRoot: string;
    sourceRoot: string;
    outputPackRoot: string;
    vanillaLayer: LayerGolden;
    customLayers: LayerGolden[];
  };
  archive: {
    path: string;
    entries: Array<{ path: string; content: string }>;
  };
  workflows: WorkflowGolden[];
}

interface LayerGolden {
  id: string;
  kind: "directory" | "zip";
  root: string;
  priority?: number;
}

interface WorkflowSourceGolden {
  language: "rsgl" | "json";
  file: string;
  anchor?: string;
  pointer?: string;
  value?: string;
}

interface WorkflowGolden {
  id: string;
  sources: WorkflowSourceGolden[];
  logicalTarget: { kind: string; id: string; key: string };
  scope: WorkflowScope;
  winner: {
    provider: string;
    origin: string;
    state: string;
    uri: string;
    anchor?: string;
    candidates?: string[];
  };
  definition: { primaryUri: string; anchor?: string; reason: string };
  graph: {
    node: string;
    originsBeforeBuild: string[];
    originsAfterBuild: string[];
    nodeCountAfterBuild: number;
    edges: Array<{ from: string; to: string; relationship: string; scope: string }>;
  };
  build: {
    action: "create" | "none";
    destination?: string;
    outputPackRoot?: string;
    ownership?: string;
    transaction?: string;
    stateAfter?: string;
    reason?: string;
  };
  invalidation: {
    trigger: string;
    effect: string;
    preserveLogicalProducer: boolean;
  };
}

const sourceFixtureRoot = path.resolve(
  "test",
  "fixtures",
  "resource-project",
  "mixed-pack"
);

describe("mixed resource-project Phase 0 fixture", () => {
  let temporaryParent: string;
  let fixtureRoot: string;
  let golden: MixedProjectGolden;
  let archiveEntries: ReadonlyMap<string, Buffer>;

  beforeEach(() => {
    temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "mcres-mixed-project-"));
    fixtureRoot = path.join(temporaryParent, "mixed-pack");
    fs.cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true });
    golden = readJson<MixedProjectGolden>(path.join(fixtureRoot, "expected", "workflows.json"));

    const entries = archiveFixtureEntries(golden);
    const archive = createDeterministicStoredZip(entries);
    const reorderedArchive = createDeterministicStoredZip([...entries].reverse());
    assert.deepStrictEqual(archive, reorderedArchive, "ZIP bytes must not depend on input enumeration order");
    fs.writeFileSync(resolveFixturePath(fixtureRoot, golden.archive.path), archive);
    archiveEntries = readDeterministicStoredZip(archive);
  });

  afterEach(() => {
    fs.rmSync(temporaryParent, { recursive: true, force: true });
  });

  it("freezes one canonical mixed project topology and deterministic custom ZIP layer", () => {
    assert.strictEqual(golden.schemaVersion, 1);
    const configFile = resolveFixturePath(fixtureRoot, golden.project.configFile);
    const config = readJson<{
      root: string;
      outDir: string;
      namespace: string;
      defaultAssetsPath: string;
      resourcePackRoots: string[];
      emitSourceMap: boolean;
      manifest: boolean;
    }>(configFile);
    assert.deepStrictEqual(config, {
      root: "rsgl/src",
      outDir: ".",
      namespace: "demo",
      defaultAssetsPath: "../vanilla",
      resourcePackRoots: ["../extern-directory", "../extern-pack-b.zip"],
      emitSourceMap: true,
      manifest: true
    });

    const configDirectory = path.dirname(configFile);
    assert.strictEqual(relativeFixturePath(fixtureRoot, path.resolve(configDirectory, config.root)), golden.project.sourceRoot);
    assert.strictEqual(relativeFixturePath(fixtureRoot, path.resolve(configDirectory, config.outDir)), golden.project.outputPackRoot);
    assert.strictEqual(
      relativeFixturePath(fixtureRoot, path.resolve(configDirectory, config.defaultAssetsPath)),
      golden.project.vanillaLayer.root
    );
    assert.deepStrictEqual(
      config.resourcePackRoots.map(root => relativeFixturePath(fixtureRoot, path.resolve(configDirectory, root))),
      golden.project.customLayers.map(layer => layer.root)
    );

    for (const requiredPath of [
      `${golden.project.packRoot}/pack.mcmeta`,
      `${golden.project.assetsRoot}/demo/models/block/handwritten.json`,
      `${golden.project.assetsRoot}/demo/models/block/handwritten_consumer.json`,
      `${golden.project.assetsRoot}/demo/models/block/custom_consumer.json`,
      `${golden.project.sourceRoot}/main.rsgl`,
      `${golden.project.sourceRoot}/features/nested.rsgl`,
      `${golden.project.vanillaLayer.root}/assets/minecraft/models/block/cube_all.json`,
      `${golden.project.customLayers[0].root}/assets/external/models/block/shared_custom.json`
    ]) {
      assert.ok(fs.existsSync(resolveFixturePath(fixtureRoot, requiredPath)), `Missing fixture path ${requiredPath}`);
    }

    assert.deepStrictEqual([...archiveEntries.keys()], golden.archive.entries.map(entry => entry.path).sort());
    for (const entry of golden.archive.entries) {
      assert.strictEqual(archiveEntries.get(entry.path)?.toString("utf8"), entry.content);
    }

    const directoryCandidate = readJson<{ fixture_origin: string }>(resolveFixturePath(
      fixtureRoot,
      "extern-directory/assets/external/models/block/shared_custom.json"
    ));
    const zipCandidate = JSON.parse(
      requiredArchiveEntry(archiveEntries, "assets/external/models/block/shared_custom.json").toString("utf8")
    ) as { fixture_origin: string };
    assert.strictEqual(directoryCandidate.fixture_origin, "custom-directory-winner");
    assert.strictEqual(zipCandidate.fixture_origin, "custom-zip-shadowed");
    assert.deepStrictEqual(golden.project.customLayers.map(layer => layer.priority), [0, 1]);
  });

  it("freezes logical target, scope, winner, definition, graph, build, and invalidation for five workflows", () => {
    assert.deepStrictEqual(golden.workflows.map(workflowSummary), [
      {
        id: "rsgl-build-to-assets",
        target: "model|demo:block/generated_live",
        scope: "generated",
        winner: "rsgl/source/unbuilt",
        definition: "project/rsgl/src/main.rsgl#model block generated_live",
        build: "create:project/assets/demo/models/block/generated_live.json",
        invalidation: "build-materialization-commit:one-project-universe-revision",
        edgeScopes: []
      },
      {
        id: "rsgl-to-local",
        target: "model|demo:block/handwritten",
        scope: "local",
        winner: "physical/handwritten/current",
        definition: "project/assets/demo/models/block/handwritten.json",
        build: "none:dependency-only",
        invalidation: "local-asset-change:re-resolve-project-consumers",
        edgeScopes: ["local"]
      },
      {
        id: "rsgl-to-vanilla",
        target: "model|minecraft:block/cube_all",
        scope: "vanilla",
        winner: "vanilla-directory/vanilla/current",
        definition: "vanilla/assets/minecraft/models/block/cube_all.json",
        build: "none:dependency-only",
        invalidation: "vanilla-layer-change:re-resolve-project-consumers",
        edgeScopes: ["vanilla"]
      },
      {
        id: "assets-to-unbuilt-rsgl",
        target: "model|demo:block/generated_live",
        scope: "effective",
        winner: "rsgl/source/unbuilt",
        definition: "project/rsgl/src/main.rsgl#model block generated_live",
        build: "none:navigation-does-not-materialize",
        invalidation: "dirty-rsgl-semantic-revision:replace-generated-project-snapshot",
        edgeScopes: ["effective"]
      },
      {
        id: "both-to-custom",
        target: "model|external:block/shared_custom",
        scope: "custom",
        winner: "custom-directory/custom/current",
        definition: "extern-directory/assets/external/models/block/shared_custom.json",
        build: "none:dependency-only",
        invalidation: "custom-layer-change:re-resolve-both-language-consumers",
        edgeScopes: ["custom", "effective"]
      }
    ]);

    assert.deepStrictEqual(golden.workflows.map(workflow => workflow.id), [
      "rsgl-build-to-assets",
      "rsgl-to-local",
      "rsgl-to-vanilla",
      "assets-to-unbuilt-rsgl",
      "both-to-custom"
    ]);

    for (const workflow of golden.workflows) {
      assert.strictEqual(
        workflow.logicalTarget.key,
        `${workflow.logicalTarget.kind}|${workflow.logicalTarget.id}`,
        `${workflow.id} must use the canonical kind|id logical key`
      );
      assert.strictEqual(workflow.graph.node, workflow.logicalTarget.key);
      assert.strictEqual(workflow.graph.nodeCountAfterBuild, 1, `${workflow.id} must not duplicate source/materialized nodes`);
      assert.strictEqual(workflow.invalidation.preserveLogicalProducer, true);
      assert.ok(workflow.sources.length > 0);
      for (const source of workflow.sources) {
        assertWorkflowSource(fixtureRoot, source, workflow.logicalTarget.id);
      }
      assertFixtureLocation(fixtureRoot, workflow.winner.uri, workflow.winner.anchor);
      assertFixtureLocation(fixtureRoot, workflow.definition.primaryUri, workflow.definition.anchor);
      for (const edge of workflow.graph.edges) {
        assert.strictEqual(edge.to, workflow.logicalTarget.key);
        assert.strictEqual(edge.relationship, "model-parent");
      }

      if (workflow.build.action === "create") {
        assert.strictEqual(workflow.build.outputPackRoot, golden.project.outputPackRoot);
        assert.strictEqual(workflow.build.ownership, "rsgl-provenance-v2");
        assert.strictEqual(workflow.build.transaction, "single-commit");
        assert.strictEqual(workflow.build.stateAfter, "current");
        assert.ok(workflow.build.destination);
        assert.strictEqual(fs.existsSync(resolveFixturePath(fixtureRoot, workflow.build.destination)), false);
        assert.strictEqual(workflow.build.destination.includes("assets/assets/"), false);
      } else {
        assert.strictEqual(workflow.build.destination, undefined);
        assert.ok(workflow.build.reason);
      }
    }

    const custom = requiredWorkflow(golden, "both-to-custom");
    assert.deepStrictEqual(custom.winner.candidates, golden.project.customLayers.map(layer => layer.id));
    assert.ok(archiveEntries.has("assets/external/models/block/shared_custom.json"));
    assert.deepStrictEqual(custom.sources.map(source => source.language), ["rsgl", "json"]);
  });
});

function archiveFixtureEntries(golden: MixedProjectGolden): DeterministicZipEntry[] {
  return golden.archive.entries.map(entry => ({ name: entry.path, content: entry.content }));
}

function workflowSummary(workflow: WorkflowGolden): Record<string, unknown> {
  const definition = `${workflow.definition.primaryUri}${workflow.definition.anchor ? `#${workflow.definition.anchor}` : ""}`;
  const build = workflow.build.action === "create"
    ? `create:${workflow.build.destination}`
    : `none:${workflow.build.reason}`;
  return {
    id: workflow.id,
    target: workflow.logicalTarget.key,
    scope: workflow.scope,
    winner: `${workflow.winner.provider}/${workflow.winner.origin}/${workflow.winner.state}`,
    definition,
    build,
    invalidation: `${workflow.invalidation.trigger}:${workflow.invalidation.effect}`,
    edgeScopes: workflow.graph.edges.map(edge => edge.scope)
  };
}

function assertWorkflowSource(fixtureRoot: string, source: WorkflowSourceGolden, targetId: string): void {
  const sourceFile = resolveFixturePath(fixtureRoot, source.file);
  assert.ok(fs.existsSync(sourceFile), `Missing workflow source ${source.file}`);
  if (source.language === "rsgl") {
    assert.ok(source.anchor);
    assertUniqueText(fs.readFileSync(sourceFile, "utf8"), source.anchor, source.file);
    return;
  }

  assert.strictEqual(source.pointer, "/parent");
  assert.strictEqual(source.value, targetId);
  const document = readJson<{ parent?: string }>(sourceFile);
  assert.strictEqual(document.parent, source.value);
}

function assertFixtureLocation(fixtureRoot: string, uri: string, anchor?: string): void {
  const fileName = resolveFixturePath(fixtureRoot, uri);
  assert.ok(fs.existsSync(fileName), `Missing expected location ${uri}`);
  if (anchor) {
    assertUniqueText(fs.readFileSync(fileName, "utf8"), anchor, uri);
  }
}

function assertUniqueText(text: string, expected: string, owner: string): void {
  const first = text.indexOf(expected);
  assert.ok(first >= 0, `${owner} does not contain '${expected}'`);
  assert.strictEqual(text.indexOf(expected, first + expected.length), -1, `${owner} contains '${expected}' more than once`);
}

function requiredWorkflow(golden: MixedProjectGolden, id: string): WorkflowGolden {
  const workflow = golden.workflows.find(candidate => candidate.id === id);
  assert.ok(workflow, `Missing workflow ${id}`);
  return workflow;
}

function requiredArchiveEntry(entries: ReadonlyMap<string, Buffer>, name: string): Buffer {
  const entry = entries.get(name);
  assert.ok(entry, `Missing ZIP entry ${name}`);
  return entry;
}

function resolveFixturePath(fixtureRoot: string, relativePath: string): string {
  const resolved = path.resolve(fixtureRoot, ...relativePath.split("/"));
  const relative = path.relative(fixtureRoot, resolved);
  assert.ok(relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return resolved;
}

function relativeFixturePath(fixtureRoot: string, fileName: string): string {
  return path.relative(fixtureRoot, fileName).split(path.sep).join("/");
}

function readJson<T>(fileName: string): T {
  return JSON.parse(fs.readFileSync(fileName, "utf8")) as T;
}
