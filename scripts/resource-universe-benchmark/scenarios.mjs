import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { pathIdentity } from "../lib/paths.mjs";
import { createStoredZipFixture } from "./zip-fixture.mjs";
import {
  measureAsynchronous,
  measureSynchronous,
  measureSynchronousBatches
} from "./statistics.mjs";

export const resourceUniverseBenchmarkScenarioIds = Object.freeze([
  "platform-path-canonicalization",
  "multi-root-project-cache",
  "synthetic-vscode-remote-project-discovery",
  "large-pack-resource-universe",
  "extraction-free-zip"
]);

export const resourceUniverseBenchmarkLimitations = Object.freeze([
  "The vscode-remote scenario uses a synthetic URI-only host. It does not claim a real SSH, WSL, or Dev Container Extension Host run.",
  "Project-service cold measurements create a new application cache but do not flush the operating-system filesystem cache.",
  "RSS is process-wide and includes the benchmark harness plus compiled module state; deltas are retained-heap observations, not isolated allocator totals.",
  "Prepared resource-search measurements exclude project discovery, VS Code QuickPick rendering, and the ResourceSearchService response LRU.",
  "Windows drive/case behavior is measured only when process.platform is win32; other platforms record that portion as not applicable.",
  "ZIP measurements use the production in-memory central-directory API with on-demand reads and do not exercise VS Code filesystem-provider IPC."
]);

export async function runResourceUniverseBenchmarkScenarios(options) {
  const { api, fixtureRoot, profile } = options;
  const scenarios = [
    await benchmarkPlatformPathCanonicalization(api, fixtureRoot, profile),
    await benchmarkMultiRootProjectCache(api, fixtureRoot, profile),
    await benchmarkSyntheticRemoteDiscovery(api, profile),
    benchmarkLargePackResourceUniverse(api, profile),
    benchmarkExtractionFreeZip(api, profile)
  ];
  assert.deepEqual(
    scenarios.map(scenario => scenario.id),
    resourceUniverseBenchmarkScenarioIds,
    "Benchmark scenario coverage changed unexpectedly."
  );
  return Object.freeze(scenarios);
}

async function benchmarkPlatformPathCanonicalization(api, fixtureRoot, profile) {
  const platformRoot = path.join(fixtureRoot, "路径 canonicalization with spaces");
  await fs.mkdir(platformRoot, { recursive: true });
  const realRoot = await fs.realpath(platformRoot);
  const rootUri = api.nodePathToResourceProjectUri(realRoot);
  const roundTripPath = api.resourceProjectUriToNodePath(rootUri);
  assert.equal(pathIdentity(roundTripPath), pathIdentity(realRoot));

  const nestedUri = api.resolveResourceProjectUri(rootUri, "子目录 with spaces\\模型.json");
  assert.ok(nestedUri.includes("%E5%AD%90%E7%9B%AE%E5%BD%95%20with%20spaces"));
  assert.ok(nestedUri.endsWith("/%E6%A8%A1%E5%9E%8B.json"));

  let windowsDriveCaseIdentityEquivalent = null;
  let windowsCaseVariantUri = null;
  if (process.platform === "win32") {
    windowsCaseVariantUri = rootUri.replace(
      /^file:\/\/\/([A-Z]):\/(.*)$/,
      (_, drive, tail) => `file:///${drive.toLowerCase()}:/${tail.toLowerCase()}`
    );
    windowsDriveCaseIdentityEquivalent = api.resourceProjectUriIdentity(rootUri)
      === api.resourceProjectUriIdentity(windowsCaseVariantUri);
    assert.equal(windowsDriveCaseIdentityEquivalent, true);
  }

  const measured = measureSynchronous(() => {
    const uri = api.nodePathToResourceProjectUri(realRoot);
    const normalized = api.normalizeResourceProjectUri(uri);
    const identity = api.resourceProjectUriIdentity(normalized);
    const joined = api.resolveResourceProjectUri(normalized, "子目录 with spaces\\模型.json");
    assert.ok(identity.startsWith("file://"));
    assert.ok(joined.endsWith("/%E6%A8%A1%E5%9E%8B.json"));
    return identity;
  }, profile.pathCanonicalizationIterations);

  return scenario("platform-path-canonicalization", false, {
    canonicalizationMilliseconds: measured.distribution
  }, {
    iterations: profile.pathCanonicalizationIterations,
    platform: process.platform,
    actualPathRoundTrips: 1
  }, {
    actualRootPath: realRoot,
    canonicalRootUri: rootUri,
    nestedBackslashReferenceUri: nestedUri,
    spacesObserved: rootUri.includes("%20"),
    nonAsciiObserved: decodeURIComponent(new URL(rootUri).pathname).includes("路径"),
    windowsDriveCaseApplicable: process.platform === "win32",
    windowsDriveCaseIdentityEquivalent,
    windowsCaseVariantUri
  });
}

async function benchmarkMultiRootProjectCache(api, fixtureRoot, profile) {
  const workspaceRoot = path.join(fixtureRoot, "multi-root 工作区 with spaces");
  const projects = [];
  for (let index = 0; index < profile.multiRootProjectCount; index += 1) {
    const projectPath = path.join(workspaceRoot, `Pack ${String(index).padStart(2, "0")} 资源`);
    const sourcePath = path.join(
      projectPath,
      "assets",
      "bench",
      "models",
      "block",
      `model_${index}.json`
    );
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(projectPath, "pack.mcmeta"), "{\"pack\":{}}", "utf8"),
      fs.writeFile(sourcePath, "{}", "utf8")
    ]);
    projects.push(Object.freeze({
      rootUri: api.nodePathToResourceProjectUri(projectPath),
      sourceUri: api.nodePathToResourceProjectUri(sourcePath),
      packMetadataUri: api.nodePathToResourceProjectUri(path.join(projectPath, "pack.mcmeta"))
    }));
  }

  const workspaceFolders = projects.map((project, index) => Object.freeze({
    uri: project.rootUri,
    configurationRevision: `benchmark-settings-${index}`
  }));
  const host = new LocalProjectHost(api, workspaceFolders);
  const cold = await measureAsynchronous(async () => {
    host.resetCounters();
    const service = new api.ResourcePackProjectService(host);
    const results = await Promise.all(projects.map(project => service.resolveProject(project.sourceUri)));
    assert.equal(results.length, profile.multiRootProjectCount);
    assert.ok(results.every(result => result.context && result.diagnostics.length === 0));
    assert.equal(new Set(results.map(result => result.context.projectId)).size, results.length);
    return Object.freeze({ service, results, statCalls: host.statCalls, readCalls: host.readCalls });
  }, profile.projectDiscoveryIterations);

  const cachedService = cold.result.service;
  const cachedResults = cold.result.results;
  host.resetCounters();
  const warm = await measureAsynchronous(async () => {
    const results = await Promise.all(projects.map(project => cachedService.resolveProject(project.sourceUri)));
    assert.ok(results.every((result, index) => result === cachedResults[index]));
    return results;
  }, profile.projectDiscoveryIterations);
  assert.equal(host.statCalls, 0, "Warm project resolution performed filesystem stat calls.");
  assert.equal(host.readCalls, 0, "Warm project resolution performed filesystem reads.");

  const unaffectedSource = projects[1].sourceUri;
  const unaffectedResult = await cachedService.resolveProject(unaffectedSource);
  host.resetCounters();
  const targeted = await measureAsynchronous(async () => {
    const invalidated = cachedService.invalidateUri(projects[0].packMetadataUri);
    assert.equal(invalidated.length, 1);
    assert.equal(cachedService.getCachedContexts().length, profile.multiRootProjectCount - 1);
    const refreshed = await cachedService.resolveProject(projects[0].sourceUri);
    const stillCached = await cachedService.resolveProject(unaffectedSource);
    assert.ok(refreshed.context);
    assert.equal(stillCached, unaffectedResult);
    return invalidated[0];
  }, profile.targetedInvalidationIterations);
  assert.ok(host.statCalls > 0, "Targeted refresh did not perform project probes.");

  return scenario("multi-root-project-cache", false, {
    coldProjectCacheBatchMilliseconds: cold.distribution,
    warmProjectCacheBatchMilliseconds: warm.distribution,
    targetedInvalidationAndRefreshMilliseconds: targeted.distribution
  }, {
    projectCount: profile.multiRootProjectCount,
    sourceCount: projects.length,
    coldIterations: profile.projectDiscoveryIterations,
    warmIterations: profile.projectDiscoveryIterations,
    targetedInvalidationIterations: profile.targetedInvalidationIterations,
    coldLastIterationStatCalls: cold.result.statCalls,
    coldLastIterationReadCalls: cold.result.readCalls,
    warmStatCalls: 0,
    warmReadCalls: 0,
    targetedRefreshStatCalls: host.statCalls,
    targetedRefreshReadCalls: host.readCalls
  }, {
    fixtureUsesCurrentPlatformFilesystem: true,
    workspaceFoldersAreIndependentPackRoots: true,
    pathsContainSpacesAndNonAscii: true,
    invalidatedProjectsPerTargetedEvent: 1,
    unaffectedProjectResultRetainedByIdentity: true,
    coldDefinition: "new ResourcePackProjectService cache; operating-system filesystem cache is not flushed"
  });
}

async function benchmarkSyntheticRemoteDiscovery(api, profile) {
  const pack = "vscode-remote://ssh-remote+benchmark/work/%E8%B5%84%E6%BA%90%20Pack";
  const source = `${pack}/assets/bench/models/block/example.json`;
  const host = new UriOnlyProjectHost(api, [{
    uri: pack,
    configurationRevision: "synthetic-remote-settings"
  }]);
  host.setFile(source, "{}", "source-r1");
  host.setFile(`${pack}/pack.mcmeta`, "{\"pack\":{}}", "pack-r1");
  host.setFile(`${pack}/rsgl/main.rsgl`, "model block remote_example {}", "rsgl-r1");

  const canonicalFromMixedCase = api.normalizeResourceProjectUri(
    "VSCODE-REMOTE://SSH-REMOTE+BENCHMARK/work/%e8%b5%84%e6%ba%90%20Pack"
  );
  assert.equal(canonicalFromMixedCase, pack);
  const sourceIdentity = api.resourceProjectUriIdentity(source);
  assert.equal(sourceIdentity, api.resourceProjectUriIdentity(source.replace("vscode-remote", "VSCODE-REMOTE")));

  const measured = await measureAsynchronous(async () => {
    host.resetCounters();
    const service = new api.ResourcePackProjectService(host);
    const result = await service.resolveProject(source);
    assert.ok(result.context);
    assert.equal(result.rsglApplicability, "conventional");
    assert.ok(result.dependencyUris.every(uri => uri.startsWith("vscode-remote:")));
    assert.ok(contextUris(result.context).every(uri => uri.startsWith("vscode-remote:")));
    assert.ok(host.probedUris.every(uri => uri.startsWith("vscode-remote:")));
    return Object.freeze({ result, statCalls: host.statCalls, readCalls: host.readCalls });
  }, profile.remoteDiscoveryIterations);

  return scenario("synthetic-vscode-remote-project-discovery", true, {
    uriOnlyProjectDiscoveryMilliseconds: measured.distribution
  }, {
    iterations: profile.remoteDiscoveryIterations,
    lastIterationStatCalls: measured.result.statCalls,
    lastIterationReadCalls: measured.result.readCalls,
    nativePathConversions: 0,
    nativePathSidecars: 0,
    workspaceScans: 0
  }, {
    scheme: "vscode-remote",
    authority: "ssh-remote+benchmark",
    canonicalUri: canonicalFromMixedCase,
    allFilesystemProbesRemainSerializedRemoteUris: true,
    contextContainsOnlySerializedRemoteUris: true,
    syntheticUriHost: true,
    realRemoteExtensionHost: false,
    claim: "URI-neutral project discovery only; not an SSH/WSL/Dev Container runtime measurement"
  });
}

function benchmarkLargePackResourceUniverse(api, profile) {
  const rssBeforeBytes = process.memoryUsage().rss;
  const construction = measureSynchronous(
    () => createPhysicalSnapshot(profile.physicalProducerCount, profile.physicalEdgeCount),
    profile.snapshotConstructionIterations
  );
  const snapshot = construction.result;
  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
  const rssAfterSnapshotBytes = process.memoryUsage().rss;
  const index = new api.ResourceUniverseIndex();
  const replacement = measureSynchronous(iteration => {
    const accepted = index.replaceSnapshot({
      ...snapshot,
      generation: iteration + 1,
      revision: `large-pack-r${iteration + 1}`
    });
    assert.equal(accepted, true);
    assert.equal(index.getProjectProducers(snapshot.projectId).length, profile.physicalProducerCount);
    return accepted;
  }, profile.atomicReplacementIterations);
  const rssAfterIndexBytes = process.memoryUsage().rss;

  const keys = snapshot.producers
    .slice(0, Math.min(profile.queryCount, snapshot.producers.length))
    .map(producer => producer.logicalKeys[0]);
  const context = Object.freeze({
    contextId: "benchmark-effective",
    projectId: snapshot.projectId,
    scope: "effective",
    orderedLayerIds: ["benchmark-local"],
    applicableProviderIds: [snapshot.providerId]
  });
  const assertResolution = key => {
    const result = index.resolve(key, context);
    assert.equal(result.status, "resolved");
    assert.equal(result.winner.logicalKeys[0].id, key.id);
  };
  const assertIncoming = key => {
    const incoming = index.getIncoming(key);
    assert.equal(incoming.length, 1);
    assert.equal(incoming[0].target.id, key.id);
  };
  const coldResolution = measureSynchronousBatches(
    keys,
    profile.queryBatchSize,
    assertResolution
  );
  const warmResolution = measureSynchronousBatches(
    keys,
    profile.queryBatchSize,
    assertResolution,
    profile.warmQueryPasses
  );
  const coldIncoming = measureSynchronousBatches(
    keys,
    profile.queryBatchSize,
    assertIncoming
  );
  const warmIncoming = measureSynchronousBatches(
    keys,
    profile.queryBatchSize,
    assertIncoming,
    profile.warmQueryPasses
  );
  const searchInventory = snapshot.producers.map(producer => {
    const target = producer.logicalKeys[0];
    return {
      target,
      producer,
      resolutionStatus: "resolved",
      navigation: {
        kind: "producer",
        producerId: producer.producerId,
        target
      }
    };
  });
  const preparedSearch = measureSynchronous(() => {
    const prepared = api.prepareResourceSearchInventory(searchInventory);
    assert.equal(prepared.size, searchInventory.length);
    return prepared;
  }, profile.snapshotConstructionIterations);
  const searchResultLimit = 200;
  const exactSearchQueries = keys
    .slice(0, Math.ceil(keys.length / 2))
    .map(target => target.id);
  const broadSearchQueries = Array.from(
    { length: Math.floor(keys.length / 2) },
    () => "model_0"
  );
  const exactResourceSearch = measureSynchronousBatches(
    exactSearchQueries,
    profile.queryBatchSize,
    query => {
      const matches = api.searchPreparedResourceInventory(preparedSearch.result, {
        query,
        kinds: ["model"],
        limit: searchResultLimit
      });
      assert.equal(matches.length, 1);
      assert.equal(matches[0].id, query);
    }
  );
  const broadResourceSearch = measureSynchronousBatches(
    broadSearchQueries,
    profile.queryBatchSize,
    query => {
      const matches = api.searchPreparedResourceInventory(preparedSearch.result, {
        query,
        kinds: ["model"],
        limit: searchResultLimit
      });
      assert.equal(matches.length, Math.min(searchResultLimit, searchInventory.length));
      assert.ok(matches.every(match => match.id.includes(query)));
    }
  );
  const rssAfterQueriesBytes = process.memoryUsage().rss;

  return scenario("large-pack-resource-universe", false, {
    snapshotConstructionMilliseconds: construction.distribution,
    atomicIndexReplacementMilliseconds: replacement.distribution,
    coldResolutionBatchMilliseconds: coldResolution.distribution,
    warmResolutionBatchMilliseconds: warmResolution.distribution,
    coldIncomingBatchMilliseconds: coldIncoming.distribution,
    warmIncomingBatchMilliseconds: warmIncoming.distribution,
    resourceSearchPreparationMilliseconds: preparedSearch.distribution,
    exactResourceSearchBatchMilliseconds: exactResourceSearch.distribution,
    broadResourceSearchBatchMilliseconds: broadResourceSearch.distribution
  }, {
    physicalProducers: snapshot.producers.length,
    physicalEdges: snapshot.edges.length,
    snapshotConstructionIterations: profile.snapshotConstructionIterations,
    atomicReplacementIterations: profile.atomicReplacementIterations,
    queriedLogicalKeys: keys.length,
    queryBatchSize: profile.queryBatchSize,
    coldResolutionOperations: coldResolution.operationCount,
    warmResolutionOperations: warmResolution.operationCount,
    coldIncomingOperations: coldIncoming.operationCount,
    warmIncomingOperations: warmIncoming.operationCount,
    resourceSearchEntries: searchInventory.length,
    resourceSearchPreparationIterations: profile.snapshotConstructionIterations,
    resourceSearchResultLimit: searchResultLimit,
    resourceSearchQueryBatchSize: profile.queryBatchSize,
    exactResourceSearchOperations: exactResourceSearch.operationCount,
    broadResourceSearchOperations: broadResourceSearch.operationCount,
    snapshotBytes,
    rssBeforeBytes,
    rssAfterSnapshotBytes,
    rssAfterIndexBytes,
    rssAfterQueriesBytes,
    rssDeltaBytes: rssAfterQueriesBytes - rssBeforeBytes,
    peakObservedRssBytes: Math.max(
      rssBeforeBytes,
      rssAfterSnapshotBytes,
      rssAfterIndexBytes,
      rssAfterQueriesBytes
    )
  }, {
    provider: "physical-benchmark",
    projectId: snapshot.projectId,
    replacementIsAtomicProviderProjectSnapshot: true,
    emittedContentIncluded: false,
    coldQueryDefinition: "first traversal of distinct logical keys after the final index replacement",
    warmQueryDefinition: `${profile.warmQueryPasses} repeated traversals of the same logical keys`,
    preparedResourceSearchModel: true,
    preparedInventoryReusedAcrossQueries: true,
    resourceSearchKind: "model",
    exactSearchWorkload: "one canonical resource id per query",
    broadSearchWorkload: "a basename prefix matching at least the configured result limit"
  });
}

function benchmarkExtractionFreeZip(api, profile) {
  const fixture = createStoredZipFixture(profile.zipEntryCount);
  const rssBeforeBytes = process.memoryUsage().rss;
  const indexed = measureSynchronous(() => api.ZipArchive.fromBytes(fixture.bytes, {
    maximumEntries: profile.zipEntryCount,
    maximumEntryBytes: 1024 * 1024
  }), profile.zipIndexIterations);
  const archive = indexed.result;
  assert.deepEqual(archive.readDirectory(""), [{ name: "assets", type: "directory" }]);
  assert.equal(archive.stat(fixture.entryPaths[0]).type, "file");
  const readPaths = evenlySelect(fixture.entryPaths, profile.zipReadCount);
  const assertRead = entryPath => {
    const bytes = archive.readFile(entryPath);
    assert.ok(bytes.byteLength > 0);
  };
  const coldReads = measureSynchronousBatches(
    readPaths,
    profile.zipReadBatchSize,
    assertRead
  );
  const warmReads = measureSynchronousBatches(
    readPaths,
    profile.zipReadBatchSize,
    assertRead,
    profile.zipWarmReadPasses
  );
  const rssAfterBytes = process.memoryUsage().rss;

  return scenario("extraction-free-zip", false, {
    centralDirectoryIndexMilliseconds: indexed.distribution,
    coldTargetedReadBatchMilliseconds: coldReads.distribution,
    warmTargetedReadBatchMilliseconds: warmReads.distribution
  }, {
    archiveEntries: profile.zipEntryCount,
    archiveBytes: fixture.bytes.byteLength,
    indexIterations: profile.zipIndexIterations,
    targetedReadPaths: readPaths.length,
    readBatchSize: profile.zipReadBatchSize,
    coldReadOperations: coldReads.operationCount,
    warmReadOperations: warmReads.operationCount,
    rssBeforeBytes,
    rssAfterBytes,
    rssDeltaBytes: rssAfterBytes - rssBeforeBytes,
    extractedFiles: 0
  }, {
    productionApi: "ZipArchive.fromBytes/readFile",
    centralDirectoryIndexedInMemory: true,
    entryReadsAreOnDemand: true,
    temporaryExtractionDirectoryCreated: false,
    compressionMethod: "stored (benchmark isolates index/read from fixture compression)"
  });
}

function scenario(id, synthetic, measurements, counts, evidence) {
  return Object.freeze({
    id,
    status: "measured",
    synthetic,
    measurements: Object.freeze(measurements),
    counts: Object.freeze(counts),
    evidence: Object.freeze(evidence)
  });
}

function createPhysicalSnapshot(producerCount, edgeCount) {
  const providerId = "physical-benchmark";
  const projectId = "benchmark-large-pack";
  const producers = Array.from({ length: producerCount }, (_, index) => {
    const suffix = String(index).padStart(6, "0");
    const logicalKey = Object.freeze({ kind: "model", id: `bench:block/model_${suffix}` });
    const location = Object.freeze({
      uri: `file:///benchmark-large-pack/assets/bench/models/block/model_${suffix}.json`,
      editable: true,
      origin: "physical"
    });
    return Object.freeze({
      producerId: `physical:${suffix}`,
      providerId,
      projectId,
      layerId: "benchmark-local",
      layerRole: "local",
      origin: "physical",
      logicalKeys: Object.freeze([logicalKey]),
      sourceOrigins: Object.freeze([location]),
      physicalOrigins: Object.freeze([location]),
      materializationState: "handwritten",
      revision: "large-pack-r1"
    });
  });
  const edges = Array.from({ length: edgeCount }, (_, index) => {
    const sourceIndex = index % producerCount;
    const targetIndex = (index + 1) % producerCount;
    return Object.freeze({
      edgeId: `physical-edge:${String(index).padStart(6, "0")}`,
      providerId,
      projectId,
      sourceProducerId: producers[sourceIndex].producerId,
      target: producers[targetIndex].logicalKeys[0],
      resolutionScope: "effective",
      resolutionContextId: "benchmark-effective",
      relationship: "model-parent",
      origin: "direct"
    });
  });
  return Object.freeze({
    providerId,
    projectId,
    generation: 1,
    revision: "large-pack-r1",
    coverage: Object.freeze({
      status: "authoritative",
      revision: "large-pack-r1",
      coveredScope: Object.freeze({ projectId, resolutionScopes: ["effective"] })
    }),
    producers: Object.freeze(producers),
    edges: Object.freeze(edges)
  });
}

class LocalProjectHost {
  statCalls = 0;
  readCalls = 0;

  constructor(api, workspaceFolders) {
    this.api = api;
    this.workspaceFolders = workspaceFolders;
  }

  getWorkspaceFolders() {
    return this.workspaceFolders;
  }

  async stat(uri) {
    this.statCalls += 1;
    try {
      const result = await fs.stat(this.api.resourceProjectUriToNodePath(uri));
      return result.isFile() ? "file" : result.isDirectory() ? "directory" : null;
    } catch (error) {
      if (error && typeof error === "object" && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return null;
      }
      throw error;
    }
  }

  async readTextFile(uri) {
    this.readCalls += 1;
    try {
      const fileName = this.api.resourceProjectUriToNodePath(uri);
      const [text, metadata] = await Promise.all([fs.readFile(fileName, "utf8"), fs.stat(fileName)]);
      return { text, revision: `${metadata.size}:${metadata.mtimeMs}` };
    } catch (error) {
      if (error && typeof error === "object" && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return null;
      }
      throw error;
    }
  }

  resetCounters() {
    this.statCalls = 0;
    this.readCalls = 0;
  }
}

class UriOnlyProjectHost {
  statCalls = 0;
  readCalls = 0;
  probedUris = [];

  constructor(api, workspaceFolders) {
    this.api = api;
    this.workspaceFolders = workspaceFolders;
    this.files = new Map();
    this.directories = new Set();
    for (const workspace of workspaceFolders) {
      this.addDirectory(workspace.uri);
    }
  }

  getWorkspaceFolders() {
    return this.workspaceFolders;
  }

  setFile(uriValue, text, revision) {
    const uri = this.api.normalizeResourceProjectUri(uriValue);
    this.files.set(this.api.resourceProjectUriIdentity(uri), { text, revision });
    const parent = this.api.resourceProjectUriParent(uri);
    if (parent) {
      this.addDirectory(parent);
    }
  }

  async stat(uriValue) {
    const uri = this.api.normalizeResourceProjectUri(uriValue);
    this.statCalls += 1;
    this.probedUris.push(uri);
    const identity = this.api.resourceProjectUriIdentity(uri);
    return this.files.has(identity) ? "file" : this.directories.has(identity) ? "directory" : null;
  }

  async readTextFile(uriValue) {
    this.readCalls += 1;
    return this.files.get(this.api.resourceProjectUriIdentity(uriValue)) ?? null;
  }

  resetCounters() {
    this.statCalls = 0;
    this.readCalls = 0;
    this.probedUris = [];
  }

  addDirectory(uriValue) {
    let uri = this.api.normalizeResourceProjectUri(uriValue);
    while (uri) {
      this.directories.add(this.api.resourceProjectUriIdentity(uri));
      uri = this.api.resourceProjectUriParent(uri);
    }
  }
}

function contextUris(context) {
  return [
    context.workspaceFolderUri,
    context.projectRootUri,
    context.packRootUri,
    context.assetsRootUri,
    ...context.rsglSourceRootUris,
    context.outputPackRootUri,
    context.outputAssetsRootUri,
    context.localLayer.rootUri,
    ...(context.vanillaLayer ? [context.vanillaLayer.rootUri] : []),
    ...context.externalLayers.map(layer => layer.rootUri)
  ];
}

function evenlySelect(values, requestedCount) {
  const count = Math.min(requestedCount, values.length);
  if (count === values.length) {
    return [...values];
  }
  const selected = [];
  for (let index = 0; index < count; index += 1) {
    selected.push(values[Math.floor(index * values.length / count)]);
  }
  return selected;
}
